import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MINIMUM_ROWS,
  evaluateMatrix,
  main,
  resolveEvidence,
  resolveVerdict,
  validateRow
} from './check-dws-completeness.mjs'

// Why a synthetic estate rather than this repo's own: a drill pinned to a real unmeasured row has
// an interest in that row staying unmeasured, and decays the day it is fixed. These fixtures
// represent the class, so the drills keep working after every real row is closed.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const tempDirs = []
const SMALL = { minimumRows: 3 }

function existsFromSet(paths) {
  const set = new Set(paths)
  return (relativePath) => set.has(relativePath)
}

function passRow(id, overrides = {}) {
  return {
    id,
    row: `Row ${id}`,
    owner: `Owner ${id}`,
    done: `Done condition ${id}`,
    state: 'PASS',
    stateSource: 'measured',
    measuredIn: 'phase-1',
    measuredAt: '2026-09-26',
    required: true,
    phases: [],
    dependsOn: [],
    evidence: [{ kind: 'file', path: `tests/evidence-${id}.test.mjs`, note: `proves row ${id}` }],
    ...overrides
  }
}

function makeMatrixEstate({ rows, namedDebt = [], scripts = {}, files = [], rawMatrix, rawPackage, omitMatrix }) {
  const root = mkdtempSync(path.join(tmpdir(), 'dws-completeness-'))
  tempDirs.push(root)
  writeFileSync(path.join(root, 'package.json'), rawPackage ?? JSON.stringify({ scripts }, null, 2))
  if (!omitMatrix) {
    mkdirSync(path.join(root, 'config'), { recursive: true })
    const text = rawMatrix ?? JSON.stringify({ schema: 'dws-completion-matrix/1', rows, namedDebt }, null, 2)
    writeFileSync(path.join(root, 'config', 'dws-completion-matrix.jsonc'), text)
  }
  for (const relativePath of files) {
    const absolute = path.join(root, relativePath)
    mkdirSync(path.dirname(absolute), { recursive: true })
    writeFileSync(absolute, '// fixture evidence file\n')
  }
  return root
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true })
  }
})

describe('a positive control and a synthetic red drill both prove their pole', () => {
  it('passes when every required row is a measured PASS with resolvable evidence', async () => {
    const rows = [passRow(1), passRow(2), passRow(3)]
    const root = makeMatrixEstate({ rows, files: rows.map((row) => row.evidence[0].path) })
    expect(await main(root, SMALL)).toBe(0)
  })

  it('fails as not-pass for exactly the one required row that is not PASS', () => {
    const rows = [
      passRow(1),
      { ...passRow(2), state: 'ABSENT', evidence: [], reason: 'not built yet' },
      passRow(3)
    ]
    const exists = existsFromSet([rows[0].evidence[0].path, rows[2].evidence[0].path])
    const { failures } = evaluateMatrix({ matrix: { rows }, exists, gateScripts: [], minimumRows: 3 })
    const notPass = failures.filter((failure) => failure.kind === 'not-pass')
    expect(notPass).toHaveLength(1)
    expect(notPass[0].id).toBe(2)
  })

  it('exits 1 through main for the same red-drill estate', async () => {
    const rows = [
      passRow(1),
      { ...passRow(2), state: 'ABSENT', evidence: [], reason: 'not built yet' },
      passRow(3)
    ]
    const root = makeMatrixEstate({ rows, files: [rows[0].evidence[0].path, rows[2].evidence[0].path] })
    expect(await main(root, SMALL)).toBe(1)
  })
})

describe('evidence must resolve, never merely be cited', () => {
  it('a PASS row citing a missing file fails as both unresolved-evidence and no-resolvable-evidence', () => {
    const rows = [passRow(1), passRow(2), passRow(3)]
    const exists = existsFromSet([rows[0].evidence[0].path, rows[2].evidence[0].path])
    const { failures } = evaluateMatrix({ matrix: { rows }, exists, gateScripts: [], minimumRows: 3 })
    const missingPath = rows[1].evidence[0].path
    expect(
      failures.some(
        (failure) => failure.kind === 'unresolved-evidence' && failure.id === 2 && failure.detail.includes(missingPath)
      )
    ).toBe(true)
    expect(failures.some((failure) => failure.kind === 'no-resolvable-evidence' && failure.id === 2)).toBe(true)
  })

  it('gate evidence: fails when the script is absent, passes when present (paired control)', async () => {
    const gateRow = (id, script) =>
      passRow(id, { evidence: [{ kind: 'gate', script, note: `runs ${script}` }] })

    const rowsAbsent = [passRow(1), gateRow(2, 'check:not-registered'), passRow(3)]
    const rootAbsent = makeMatrixEstate({
      rows: rowsAbsent,
      scripts: {},
      files: [rowsAbsent[0].evidence[0].path, rowsAbsent[2].evidence[0].path]
    })
    expect(await main(rootAbsent, SMALL)).toBe(1)

    const rowsPresent = [passRow(1), gateRow(2, 'check:registered'), passRow(3)]
    const rootPresent = makeMatrixEstate({
      rows: rowsPresent,
      scripts: { 'check:registered': 'node registered.mjs' },
      files: [rowsPresent[0].evidence[0].path, rowsPresent[2].evidence[0].path]
    })
    expect(await main(rootPresent, SMALL)).toBe(0)
  })

  it('commit-only evidence on a PASS row is never resolvable, and is not a stale citation', () => {
    const rows = [passRow(1), passRow(2, { evidence: [{ kind: 'commit', sha: 'abcdef1' }] }), passRow(3)]
    const exists = existsFromSet([rows[0].evidence[0].path, rows[2].evidence[0].path])
    const { failures } = evaluateMatrix({ matrix: { rows }, exists, gateScripts: [], minimumRows: 3 })
    const forRow2 = failures.filter((failure) => failure.id === 2)
    expect(forRow2.map((failure) => failure.kind)).toEqual(['no-resolvable-evidence'])
  })

  it('a stage-zero-seed PASS with resolvable evidence is still refused as unmeasured-pass', () => {
    const rows = [passRow(1), passRow(2, { stateSource: 'stage-zero-seed' }), passRow(3)]
    const exists = existsFromSet(rows.map((row) => row.evidence[0].path))
    const { failures } = evaluateMatrix({ matrix: { rows }, exists, gateScripts: [], minimumRows: 3 })
    const forRow2 = failures.filter((failure) => failure.id === 2)
    expect(forRow2.map((failure) => failure.kind)).toEqual(['unmeasured-pass'])
  })

  it('a non-PASS row citing a missing file is still a stale citation', () => {
    const rows = [
      passRow(1),
      {
        ...passRow(2),
        state: 'ABSENT',
        reason: 'not built yet',
        evidence: [{ kind: 'file', path: 'nowhere.ts', note: 'stale' }]
      },
      passRow(3)
    ]
    const exists = existsFromSet([rows[0].evidence[0].path, rows[2].evidence[0].path])
    const { failures } = evaluateMatrix({ matrix: { rows }, exists, gateScripts: [], minimumRows: 3 })
    expect(failures.some((failure) => failure.kind === 'unresolved-evidence' && failure.id === 2)).toBe(true)
  })
})

describe('population floor', () => {
  it('fewer rows than the floor is a checker internal failure', async () => {
    const rows = [passRow(1), passRow(2)]
    const root = makeMatrixEstate({ rows, files: rows.map((row) => row.evidence[0].path) })
    expect(await main(root, SMALL)).toBe(2)
  })

  it('pins the production floor so the override seam cannot quietly lower it', () => {
    expect(MINIMUM_ROWS).toBe(55)
  })
})

describe('schema problems are a checker internal failure, not a contract failure', () => {
  const cases = {
    'duplicate id': (rows) => {
      rows[1] = { ...rows[1], id: rows[0].id }
    },
    'non-contiguous ids': (rows) => {
      rows[2] = { ...rows[2], id: 4 }
    },
    'unknown state': (rows) => {
      rows[1] = { ...rows[1], state: 'DONE' }
    },
    'non-PASS without reason': (rows) => {
      rows[1] = { ...rows[1], state: 'ABSENT', evidence: [] }
      delete rows[1].reason
    },
    'evidence path escaping the checkout': (rows) => {
      rows[1] = { ...rows[1], evidence: [{ kind: 'file', path: '../escape.ts', note: 'x' }] }
    },
    'required:false without reason': (rows) => {
      rows[1] = { ...rows[1], required: false }
      delete rows[1].reason
    },
    'measured without measuredAt': (rows) => {
      rows[1] = { ...rows[1] }
      delete rows[1].measuredAt
    }
  }

  for (const [name, mutate] of Object.entries(cases)) {
    it(`${name} -> CHECKER INTERNAL FAILURE`, async () => {
      const rows = [passRow(1), passRow(2), passRow(3)]
      mutate(rows)
      const root = makeMatrixEstate({ rows, files: [rows[0].evidence[0].path, rows[2].evidence[0].path] })
      expect(await main(root, SMALL)).toBe(2)
    })
  }

  it('required:false with a reason among otherwise-PASS rows is not a failure (paired control)', async () => {
    const rows = [
      passRow(1),
      {
        ...passRow(2),
        required: false,
        state: 'ABSENT',
        evidence: [],
        reason: 'not required in this program'
      },
      passRow(3)
    ]
    const root = makeMatrixEstate({ rows, files: [rows[0].evidence[0].path, rows[2].evidence[0].path] })
    expect(await main(root, SMALL)).toBe(0)
  })
})

describe('unreadable input gets its own verdict, distinct from the steady red', () => {
  it('no matrix file at all', async () => {
    const root = makeMatrixEstate({ rows: [], omitMatrix: true })
    expect(await main(root, SMALL)).toBe(3)
  })

  it('an unterminated JSONC object', async () => {
    const root = makeMatrixEstate({ rawMatrix: '{ "schema": "x", "rows": [' })
    expect(await main(root, SMALL)).toBe(3)
  })

  it('an unparseable package.json', async () => {
    const rows = [passRow(1), passRow(2), passRow(3)]
    const root = makeMatrixEstate({ rows, rawPackage: '{ invalid json', files: rows.map((row) => row.evidence[0].path) })
    expect(await main(root, SMALL)).toBe(3)
  })
})

describe('JSONC tolerance', () => {
  it('comments and a trailing comma parse fine', async () => {
    const rows = [passRow(1), passRow(2), passRow(3)]
    const rowsJson = JSON.stringify(rows, null, 2)
    const rawMatrix =
      `// leading comment describing this fixture\n` +
      `{\n  "schema": "dws-completion-matrix/1",\n  "rows": ${rowsJson},\n  "namedDebt": [],\n}\n`
    const root = makeMatrixEstate({ rawMatrix, files: rows.map((row) => row.evidence[0].path) })
    expect(await main(root, SMALL)).toBe(0)
  })
})

// Positive controls against the real estate. Without these, a sweep that silently stopped seeing
// this repository's own matrix would report a clean bill and every synthetic case above would
// still pass.
describe('the sweep can still see this repository', () => {
  it('is judgeable against the real matrix (never a checker or input failure)', async () => {
    expect([0, 1]).toContain(await main(REPO_ROOT))
  })

  it('the real matrix has zero internal failures, 55 rows, and no stale citation', () => {
    const rawMatrix = readFileSync(path.join(REPO_ROOT, 'config', 'dws-completion-matrix.jsonc'), 'utf8')
    const withoutComments = rawMatrix.replace(/^\/\/.*$/gm, '')
    const matrix = JSON.parse(withoutComments)
    const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))
    const gateScripts = Object.keys(manifest.scripts ?? {})
    const exists = (relativePath) => existsSync(path.join(REPO_ROOT, relativePath))
    const { failures, internalFailures, counts } = evaluateMatrix({
      matrix,
      exists,
      gateScripts,
      minimumRows: MINIMUM_ROWS
    })
    expect(internalFailures).toEqual([])
    expect(counts.total).toBe(55)
    expect(failures.filter((failure) => failure.kind === 'unresolved-evidence')).toEqual([])
  })
})

describe('pure helpers', () => {
  it('validateRow accepts a well-formed PASS row', () => {
    expect(validateRow(passRow(1))).toEqual([])
  })

  it('resolveEvidence never resolves a commit', () => {
    const result = resolveEvidence({ kind: 'commit', sha: 'abcdef1' }, { exists: () => true, gateScripts: [] })
    expect(result.resolved).toBe(false)
  })

  it('resolveVerdict prioritizes internal failures over contract failures', () => {
    expect(resolveVerdict({ failures: [{}], internalFailures: [{}] }).code).toBe(2)
    expect(resolveVerdict({ failures: [{}], internalFailures: [] }).code).toBe(1)
    expect(resolveVerdict({ failures: [], internalFailures: [] }).code).toBe(0)
  })
})
