import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

import { parse as parseYaml } from 'yaml'

// Why: pr.yml re-lists the `lint` chain as individual steps so a single failure does not mask the
// rest and oxlint keeps its `--format github` annotations. Hand-maintained mirrors drift (#10601:
// three verifiers never ran on PRs), so a gate fails the moment a `lint` step has no counterpart
// on pull requests.
//
// The claim is "every lint step runs on a pull request", not "every lint step is in pr.yml".
// A gate may live in its own workflow -- check:ci-gate-coverage does, deliberately, so that a gate
// hunting for gates mounted on dead events is not itself one. That workflow fires on
// `pull_request`, so it satisfies the claim, and scanning only pr.yml reported it as missing.
//
// Widening the sweep makes working-directory load-bearing. mobile.yml runs `pnpm lint` under
// `working-directory: mobile`; resolved against the ROOT scripts it would credit every leaf of the
// root chain in one stroke and leave the gate permanently green while enforcing nothing.
//
// This lives beside the test rather than inside it because the logic has a second caller: deciding
// whether a gate arriving from another branch will have an executor once the branches meet.

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

export function readWorkflows(root = process.cwd()) {
  const dir = path.join(root, WORKFLOW_DIR)
  return readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => parseYaml(readFileSync(path.join(dir, name), 'utf8')))
}
