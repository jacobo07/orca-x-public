import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  findMissingLintSteps,
  readWorkflows,
  runsOnPullRequest
} from './pr-workflow-lint-parity.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

describe('PR workflow lint parity', () => {
  it('runs every `pnpm lint` step on pull requests', () => {
    const { scripts } = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))
    const missing = findMissingLintSteps({ scripts, workflows: readWorkflows(REPO_ROOT) })

    expect(
      missing,
      `no pull-request workflow runs these \`pnpm lint\` steps: ${missing.join(', ')}. ` +
        'Add a step for each one so PR CI matches `pnpm lint`.'
    ).toEqual([])
  })

  // Positive control: without this, a sweep that silently stopped reading .github/workflows would
  // report the estate clean and every synthetic case below would still pass.
  it("actually reads this repository's pull-request workflows", () => {
    const workflows = readWorkflows(REPO_ROOT)
    expect(workflows.length).toBeGreaterThan(20)
    expect(workflows.filter((document) => runsOnPullRequest(document)).length).toBeGreaterThan(1)
  })
})

describe('what may credit a lint step', () => {
  const scripts = { lint: 'oxlint && pnpm run check:x', 'check:x': 'node config/scripts/x.mjs' }

  function workflow({ on, steps, cwd }) {
    return {
      on,
      jobs: {
        j: { ...(cwd ? { defaults: { run: { 'working-directory': cwd } } } : {}), steps }
      }
    }
  }

  it('credits a pull-request workflow that is not pr.yml', () => {
    const workflows = [
      workflow({ on: { pull_request: null }, steps: [{ run: 'pnpm exec oxlint' }] }),
      workflow({ on: { pull_request: null, push: null }, steps: [{ run: 'pnpm run check:x' }] })
    ]
    expect(findMissingLintSteps({ scripts, workflows })).toEqual([])
  })

  // The discriminating case for widening the sweep. mobile.yml really does run `pnpm lint`.
  it('does not credit a step running in another package', () => {
    const workflows = [
      workflow({ on: { pull_request: null }, steps: [{ run: 'pnpm exec oxlint' }] }),
      workflow({ on: { pull_request: null }, cwd: 'mobile', steps: [{ run: 'pnpm lint' }] })
    ]
    expect(findMissingLintSteps({ scripts, workflows })).toEqual(['config/scripts/x.mjs'])
  })

  it('does not credit a workflow that never runs on a pull request', () => {
    const workflows = [
      workflow({ on: { pull_request: null }, steps: [{ run: 'pnpm exec oxlint' }] }),
      workflow({ on: { schedule: [{ cron: '0 * * * *' }] }, steps: [{ run: 'pnpm run check:x' }] })
    ]
    expect(findMissingLintSteps({ scripts, workflows })).toEqual(['config/scripts/x.mjs'])
  })

  it('reads `on` however the parser rendered it', () => {
    expect(runsOnPullRequest({ on: { pull_request: null } })).toBe(true)
    expect(runsOnPullRequest({ on: ['push', 'pull_request'] })).toBe(true)
    expect(runsOnPullRequest({ on: 'pull_request' })).toBe(true)
    // YAML 1.1 folds the bare key `on` to boolean true.
    expect(runsOnPullRequest({ [true]: { pull_request: null } })).toBe(true)
    expect(runsOnPullRequest({ on: { push: null } })).toBe(false)
    expect(runsOnPullRequest({})).toBe(false)
  })

  it('still credits a step that overrides the job default back to the root', () => {
    const workflows = [
      workflow({
        on: { pull_request: null },
        cwd: 'mobile',
        steps: [
          { run: 'pnpm exec oxlint', 'working-directory': '.' },
          { run: 'pnpm run check:x', 'working-directory': '.' }
        ]
      })
    ]
    expect(findMissingLintSteps({ scripts, workflows })).toEqual([])
  })
})

// The integration contract for a gate arriving from another branch. orca-x/cognitive-workspace
// wires check:workspace-trust-authority -- the gate over the workspace execution trust boundary --
// into `lint`, and no workflow runs `pnpm lint`. This pins that both owners refuse it on merge,
// so the security gate cannot land without an executor.
describe('a gate arriving from another branch needs an executor here', () => {
  it('refuses a lint-chained gate that no pull-request workflow runs', () => {
    const { scripts } = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))
    const merged = {
      ...scripts,
      'check:workspace-trust-authority': 'node config/scripts/check-workspace-trust-authority.mjs',
      lint: `${scripts.lint} && pnpm run check:workspace-trust-authority`
    }

    expect(findMissingLintSteps({ scripts: merged, workflows: readWorkflows(REPO_ROOT) })).toEqual([
      'config/scripts/check-workspace-trust-authority.mjs'
    ])
    // Paired control: with a pr.yml-style step the same gate is accepted, so the case above is
    // about the missing executor rather than about the gate's name.
    expect(
      findMissingLintSteps({
        scripts: merged,
        workflows: [
          ...readWorkflows(REPO_ROOT),
          {
            on: { pull_request: null },
            jobs: { j: { steps: [{ run: 'pnpm run check:workspace-trust-authority' }] } }
          }
        ]
      })
    ).toEqual([])
  })
})
