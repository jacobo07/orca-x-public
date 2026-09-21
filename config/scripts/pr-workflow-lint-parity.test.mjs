import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

// Why: pr.yml re-lists the `lint` chain as individual steps so a single failure
// does not mask the rest and oxlint keeps its `--format github` annotations.
// Hand-maintained mirrors drift (#10601: three verifiers never ran on PRs), so
// this gate fails the moment a `lint` step has no counterpart on pull requests.
//
// The claim is "every lint step runs on a pull request", not "every lint step is in pr.yml".
// A gate may live in its own workflow — check:ci-gate-coverage does, deliberately, so that a gate
// hunting for gates mounted on dead events is not itself one. That workflow fires on
// `pull_request`, so it satisfies the claim, and scanning only pr.yml reported it as missing.
//
// Widening the sweep makes working-directory load-bearing. mobile.yml runs `pnpm lint` under
// `working-directory: mobile`; resolved against the ROOT scripts it would credit every leaf of the
// root chain in one stroke and leave this gate permanently green while enforcing nothing.

const WORKFLOW_DIR = path.join('.github', 'workflows')

// Flags that only change reporting, so they must not split two otherwise identical commands.
const REPORTING_FLAGS_WITH_VALUE = new Set(['--format', '--reporter'])
const REPORTING_FLAGS = new Set(['--quiet'])
const PACKAGE_RUNNER_TOKENS = new Set(['pnpm', 'npm', 'yarn', 'npx', 'run', 'exec', 'node'])

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function splitCommandChain(command) {
  return command
    .split(/\n|&&|;/)
    .map((part) => part.trim())
    .filter(Boolean)
}

function canonicalize(command) {
  const tokens = command.split(/\s+/)
  const canonical = []

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (canonical.length === 0 && PACKAGE_RUNNER_TOKENS.has(token)) {
      continue
    }
    if (REPORTING_FLAGS.has(token)) {
      continue
    }
    if (REPORTING_FLAGS_WITH_VALUE.has(token)) {
      index += 1
      continue
    }
    canonical.push(token)
  }

  return canonical.join(' ')
}

/** Expands `pnpm run x` indirection until every entry is a real binary invocation. */
export function resolveLeafCommands(command, scripts, seen = new Set()) {
  const leaves = []

  for (const part of splitCommandChain(command)) {
    const scriptName = part.match(/^(?:pnpm|npm|yarn)(?:\s+run)?\s+([\w:-]+)$/)?.[1]
    if (scriptName && scripts[scriptName] && !seen.has(scriptName)) {
      leaves.push(
        ...resolveLeafCommands(scripts[scriptName], scripts, new Set([...seen, scriptName]))
      )
      continue
    }
    leaves.push(canonicalize(part))
  }

  return leaves
}

/**
 * Does this workflow run on pull requests?
 *
 * `on` is read through a boolean-true fallback because YAML 1.1 parsers fold the bare key `on`
 * to the boolean true. Getting this wrong fails silently in the safe-looking direction: every
 * workflow reads as not-PR-triggered, the union of credited commands is empty, and the gate
 * accuses the whole lint chain instead of going quietly green.
 */
export function runsOnPullRequest(document) {
  const triggers = document?.on ?? document?.[true]
  if (typeof triggers === 'string') {
    return triggers === 'pull_request'
  }
  if (Array.isArray(triggers)) {
    return triggers.includes('pull_request')
  }
  return isRecord(triggers) && Object.hasOwn(triggers, 'pull_request')
}

function isRootWorkingDirectory(cwd) {
  return cwd === undefined || cwd === null || cwd === '' || cwd === '.' || cwd === './'
}

/** Every `run:` step of this workflow that executes against the ROOT package.json. */
function* rootRunSteps(document) {
  const workflowDefault = document?.defaults?.run?.['working-directory']
  for (const job of Object.values(isRecord(document?.jobs) ? document.jobs : {})) {
    if (!isRecord(job)) {
      continue
    }
    const jobDefault = job.defaults?.run?.['working-directory'] ?? workflowDefault
    for (const step of Array.isArray(job.steps) ? job.steps : []) {
      if (!isRecord(step) || typeof step.run !== 'string') {
        continue
      }
      if (isRootWorkingDirectory(step['working-directory'] ?? jobDefault)) {
        yield step.run
      }
    }
  }
}

/** Leaves of the `lint` chain that no pull-request-triggered workflow runs at the root. */
export function findMissingLintSteps({ scripts, workflows }) {
  const covered = new Set(
    workflows
      .filter((document) => runsOnPullRequest(document))
      .flatMap((document) => [...rootRunSteps(document)])
      .flatMap((run) => resolveLeafCommands(run, scripts))
  )
  return resolveLeafCommands(scripts.lint, scripts).filter((leaf) => !covered.has(leaf))
}

function readWorkflows() {
  return readdirSync(WORKFLOW_DIR)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => parse(readFileSync(path.join(WORKFLOW_DIR, name), 'utf8')))
}

describe('PR workflow lint parity', () => {
  it('runs every `pnpm lint` step on pull requests', () => {
    const { scripts } = JSON.parse(readFileSync('package.json', 'utf8'))
    const missing = findMissingLintSteps({ scripts, workflows: readWorkflows() })

    expect(
      missing,
      `no pull-request workflow runs these \`pnpm lint\` steps: ${missing.join(', ')}. ` +
        'Add a step for each one so PR CI matches `pnpm lint`.'
    ).toEqual([])
  })

  // Positive control: without this, a sweep that silently stopped reading .github/workflows would
  // report the estate clean and every synthetic case below would still pass.
  it('actually reads this repository\'s pull-request workflows', () => {
    const workflows = readWorkflows()
    expect(workflows.length).toBeGreaterThan(20)
    expect(workflows.filter((document) => runsOnPullRequest(document)).length).toBeGreaterThan(1)
  })
})

describe('what may credit a lint step', () => {
  const scripts = { lint: 'oxlint && pnpm run check:x', 'check:x': 'node config/scripts/x.mjs' }

  function workflow({ on, steps, cwd }) {
    return { on, jobs: { j: { ...(cwd ? { defaults: { run: { 'working-directory': cwd } } } : {}), steps } } }
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
