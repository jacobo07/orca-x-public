import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MINIMUM_GATE_SCRIPTS,
  MINIMUM_WORKFLOW_FILES,
  buildCoverageIndex,
  collectGateScripts,
  evaluateCoverage,
  extractInvocations,
  extractScriptTarget,
  isCovered,
  main,
  parseBaseline,
  resolveVerdict
} from './check-ci-gate-coverage.mjs'

// Why a synthetic estate rather than this repo's own: a drill pinned to a real unwired gate has an
// interest in that gate staying unwired and decays the day it is fixed. These fixtures represent
// the class, so they keep working once every real gate is wired — and each green control is what
// stops a checker that refuses everything from passing the red half beside it.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const tempDirs = []

function makeEstate({ scripts, workflows, actions, baseline }) {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-gate-coverage-'))
  tempDirs.push(root)
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts }, null, 2))
  const workflowDir = path.join(root, '.github', 'workflows')
  mkdirSync(workflowDir, { recursive: true })
  for (const [name, body] of Object.entries(workflows ?? {})) {
    writeFileSync(path.join(workflowDir, name), body)
  }
  for (const [name, body] of Object.entries(actions ?? {})) {
    const dir = path.join(root, '.github', 'actions', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'action.yml'), body)
  }
  if (baseline !== undefined) {
    mkdirSync(path.join(root, 'config'), { recursive: true })
    writeFileSync(path.join(root, 'config', 'ci-gate-coverage-baseline.txt'), baseline)
  }
  return root
}

const SMALL = { minimumGateScripts: 1, minimumWorkflowFiles: 1 }

function workflow(steps) {
  return `name: w\njobs:\n  j:\n    steps:\n${steps}`
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true })
  }
})

describe('an unwired gate is refused, and a wired one is not', () => {
  it('fails when a workflow invokes no such gate', async () => {
    const root = makeEstate({
      scripts: { 'check:wired': 'node a.mjs', 'check:unwired': 'node b.mjs' },
      workflows: { 'pr.yml': workflow('      - run: pnpm run check:wired\n') }
    })
    expect(await main(root, SMALL)).toBe(1)
  })

  it('passes when every gate is invoked (green control)', async () => {
    const root = makeEstate({
      scripts: { 'check:wired': 'node a.mjs', 'check:other': 'node b.mjs' },
      workflows: {
        'pr.yml': workflow('      - run: pnpm run check:wired\n      - run: pnpm check:other\n')
      }
    })
    expect(await main(root, SMALL)).toBe(0)
  })

  it('counts a composite action step, which workflows reach via `uses`', async () => {
    const root = makeEstate({
      scripts: { 'check:x': 'node a.mjs' },
      workflows: { 'pr.yml': workflow('      - uses: ./.github/actions/setup\n') },
      actions: { setup: 'runs:\n  using: composite\n  steps:\n    - run: pnpm run check:x\n' }
    })
    expect(await main(root, SMALL)).toBe(0)
  })

  it('sweeps .yaml as well as .yml', async () => {
    const root = makeEstate({
      scripts: { 'check:x': 'node a.mjs' },
      workflows: { 'labeler.yaml': workflow('      - run: pnpm run check:x\n') }
    })
    expect(await main(root, SMALL)).toBe(0)
  })
})

describe('a step that runs in another package does not count for this one', () => {
  // mobile.yml runs `pnpm lint` under `working-directory: mobile`. Crediting that to the root
  // package.json would mark every gate chained into root `lint` as covered in one stroke.
  it('ignores a step whose job default working-directory is not the root', async () => {
    const root = makeEstate({
      scripts: { 'check:x': 'node a.mjs' },
      workflows: {
        'mobile.yml':
          'name: m\njobs:\n  j:\n    defaults:\n      run:\n        working-directory: mobile\n    steps:\n      - run: pnpm run check:x\n'
      }
    })
    expect(await main(root, SMALL)).toBe(1)
  })

  it('counts a step that overrides the job default back to the root', async () => {
    const root = makeEstate({
      scripts: { 'check:x': 'node a.mjs' },
      workflows: {
        'mobile.yml':
          'name: m\njobs:\n  j:\n    defaults:\n      run:\n        working-directory: mobile\n    steps:\n      - run: pnpm run check:x\n        working-directory: .\n'
      }
    })
    expect(await main(root, SMALL)).toBe(0)
  })
})

describe('invocation extraction matches names exactly', () => {
  it('reads `pnpm run name`, `pnpm name` and an env-prefixed call', () => {
    const { names } = extractInvocations('pnpm run check:a\npnpm check:b\nCI=1 pnpm run check:c')
    expect([...names].sort()).toEqual(['check:a', 'check:b', 'check:c'])
  })

  // The discriminating case. A substring match credits an unwired parent for its child's step.
  it('does not credit a prefix script for its longer sibling', () => {
    const { names } = extractInvocations('pnpm run audit:code-quality:native')
    expect(names.has('audit:code-quality')).toBe(false)
    expect(names.has('audit:code-quality:native')).toBe(true)
  })

  it('splits a chained run block so every command is seen', () => {
    const { names } = extractInvocations('pnpm run check:a && pnpm run check:b || pnpm run check:c')
    expect(names.size).toBe(3)
  })

  it('reads a direct node invocation as a file, normalising separators', () => {
    const { files } = extractInvocations('node config/scripts/verify-cli-bin.mjs')
    expect(files.has('config/scripts/verify-cli-bin.mjs')).toBe(true)
  })

  // Conservative on purpose: a missed target reports a wired gate as uncovered, which someone
  // investigates, whereas over-matching reports a dead gate as alive and nobody looks again.
  it('extracts no target from a flagged invocation rather than guessing an argument', () => {
    expect(extractScriptTarget('node --experimental a.mjs --out b.mjs')).toBe(null)
    expect(extractScriptTarget('node config/scripts/a.mjs')).toBe('config/scripts/a.mjs')
  })

  it('matches a gate invoked only by its file path', () => {
    const index = buildCoverageIndex([
      { jobs: { j: { steps: [{ run: 'node config/scripts/verify-cli-bin.mjs' }] } } }
    ])
    expect(isCovered('verify:cli-bin', 'node config/scripts/verify-cli-bin.mjs', index)).toBe(true)
    expect(isCovered('verify:other', 'node config/scripts/other.mjs', index)).toBe(false)
  })
})

describe('the baseline is debt, and it may only shrink', () => {
  it('suppresses a recorded gate that carries a reason', async () => {
    const root = makeEstate({
      scripts: { 'check:unwired': 'node b.mjs' },
      workflows: { 'pr.yml': workflow('      - run: echo hi\n') },
      baseline: '# header\ncheck:unwired  # needs a macOS runner we do not have\n'
    })
    expect(await main(root, SMALL)).toBe(0)
  })

  it('refuses a stale entry whose gate is now wired', async () => {
    const root = makeEstate({
      scripts: { 'check:unwired': 'node b.mjs' },
      workflows: { 'pr.yml': workflow('      - run: pnpm run check:unwired\n') },
      baseline: '# header\ncheck:unwired  # needs a macOS runner we do not have\n'
    })
    expect(await main(root, SMALL)).toBe(1)
  })

  it('refuses a stale entry naming a script that no longer exists', async () => {
    const root = makeEstate({
      scripts: { 'check:wired': 'node a.mjs' },
      workflows: { 'pr.yml': workflow('      - run: pnpm run check:wired\n') },
      baseline: '# header\ncheck:deleted  # was never wired\n'
    })
    expect(await main(root, SMALL)).toBe(1)
  })

  it('treats a reasonless entry as the checker being unable to judge, not as debt', async () => {
    const root = makeEstate({
      scripts: { 'check:unwired': 'node b.mjs' },
      workflows: { 'pr.yml': workflow('      - run: echo hi\n') },
      baseline: '# header\ncheck:unwired\n'
    })
    expect(await main(root, SMALL)).toBe(2)
  })

  it('parses name and reason, and reports a line that is neither', () => {
    const { entries, malformed } = parseBaseline('# c\na:b  # why\nbare-line\n')
    expect(entries.get('a:b')).toBe('why')
    expect(malformed).toEqual(['bare-line'])
  })
})

describe('the checker refuses a clean bill it cannot support', () => {
  it('fails as an internal failure when too few gate scripts are found', async () => {
    const root = makeEstate({
      scripts: { 'check:only': 'node a.mjs' },
      workflows: { 'pr.yml': workflow('      - run: pnpm run check:only\n') }
    })
    // Everything is covered, so a floorless checker reports success on a near-empty estate.
    expect(await main(root, { minimumWorkflowFiles: 1 })).toBe(2)
  })

  it('fails as an internal failure when too few CI definitions are swept', async () => {
    const root = makeEstate({
      scripts: { 'check:only': 'node a.mjs' },
      workflows: { 'pr.yml': workflow('      - run: pnpm run check:only\n') }
    })
    expect(await main(root, { minimumGateScripts: 1 })).toBe(2)
  })

  it('reports an unparseable workflow as an internal failure, not as uncovered gates', async () => {
    const root = makeEstate({
      scripts: { 'check:x': 'node a.mjs' },
      workflows: { 'pr.yml': 'name: [unclosed\n  - : :\n' }
    })
    expect(await main(root, SMALL)).toBe(2)
  })

  it('reports unreadable input when package.json cannot be parsed', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ci-gate-coverage-'))
    tempDirs.push(root)
    writeFileSync(path.join(root, 'package.json'), '{ not json')
    expect(await main(root, SMALL)).toBe(1)
  })

  it('pins the production floors so the test seam cannot become how they are lowered', () => {
    expect(MINIMUM_GATE_SCRIPTS).toBe(20)
    expect(MINIMUM_WORKFLOW_FILES).toBe(25)
  })
})

describe('verdict precedence', () => {
  it('an internal failure outranks a contract failure', () => {
    expect(resolveVerdict({ failures: ['a'], internalFailures: ['b'] }).code).toBe(2)
  })

  it('a contract failure outranks success', () => {
    expect(resolveVerdict({ failures: ['a'], internalFailures: [] }).code).toBe(1)
  })

  it('nothing wrong is success', () => {
    expect(resolveVerdict({ failures: [], internalFailures: [] }).code).toBe(0)
  })
})

describe('enumeration', () => {
  it('collects only gate-shaped scripts', () => {
    expect(collectGateScripts({ 'check:a': 'x', 'verify:b': 'x', build: 'x', 'test:c': 'x' })).toEqual([
      'check:a',
      'verify:b'
    ])
  })

  it('survives a package.json with no scripts block', () => {
    expect(collectGateScripts(undefined)).toEqual([])
  })

  it('names every uncovered gate, not just the first', () => {
    const { failures } = evaluateCoverage({
      gateScripts: ['check:a', 'check:b'],
      scripts: { 'check:a': 'node a.mjs', 'check:b': 'node b.mjs' },
      index: { names: new Set(), files: new Set() },
      baseline: new Map()
    })
    expect(failures).toHaveLength(2)
  })
})

// Positive controls against the real estate. Without these, a sweep that silently stopped seeing
// this repo's workflows would report a clean bill and every synthetic case above would still pass.
describe('the sweep can still see this repository', () => {
  it('finds the real gate scripts and CI definitions above both floors', async () => {
    expect(await main(REPO_ROOT)).toBe(0)
  })

  it('never exempts a gate that is meant to be wired', () => {
    const raw = readFileSync(path.join(REPO_ROOT, 'config', 'ci-gate-coverage-baseline.txt'), 'utf8')
    const { entries } = parseBaseline(raw)
    // Wiring these into CI is the whole point of the gate; exempting one is how the fix is undone.
    for (const name of [
      'check:recurring-work',
      'check:ipc-message-floor',
      'check:runtime-host-queue',
      'check:execution-host-scope',
      'check:variant-parity',
      'check:mobile-aperture',
      'check:visual-assets',
      'check:status-semantics'
    ]) {
      expect(entries.has(name)).toBe(false)
    }
  })
})
