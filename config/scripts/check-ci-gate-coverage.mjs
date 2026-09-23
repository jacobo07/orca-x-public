import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

import { parse as parseYaml } from 'yaml'

const PACKAGE_PATH = 'package.json'
const WORKFLOW_DIR = path.join('.github', 'workflows')
const ACTION_DIR = path.join('.github', 'actions')
const BASELINE_PATH = path.join('config', 'ci-gate-coverage-baseline.txt')

// Why: a gate script's whole job is to refuse. Builds, formatters and servers are not gates.
const GATE_PREFIXES = ['check:', 'verify:']

// Why floors: a sweep that silently stops matching reports full coverage of an empty set, which is
// indistinguishable from a healthy estate. Both populations are floored so the instrument has to
// prove it could still see before its clean bill is believed. Sized below today's real counts so a
// deliberate removal does not fail the gate, high enough that losing a handful does.
export const MINIMUM_GATE_SCRIPTS = 20
export const MINIMUM_WORKFLOW_FILES = 25

export const VERDICT_CONTRACT_VALID = 'CONTRACT VALID'
export const VERDICT_CONTRACT_INVALID = 'CONTRACT INVALID'
export const VERDICT_UNREADABLE_INPUT = 'UNREADABLE INPUT'
export const VERDICT_CHECKER_INTERNAL_FAILURE = 'CHECKER INTERNAL FAILURE'

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function collectGateScripts(scripts) {
  if (!isRecord(scripts)) {
    return []
  }
  return Object.keys(scripts)
    .filter((name) => GATE_PREFIXES.some((prefix) => name.startsWith(prefix)))
    .sort()
}

function isRootWorkingDirectory(cwd) {
  return cwd === undefined || cwd === null || cwd === '' || cwd === '.' || cwd === './'
}

/**
 * Yield every `run:` step with the working directory it actually executes in.
 *
 * The cwd matters because `pnpm lint` under `working-directory: mobile` runs mobile's lint, not the
 * root one. Crediting it to the root package.json would mark every gate chained into root `lint` as
 * covered in a single stroke — a gate green at birth, enforcing nothing.
 */
export function* iterateRunSteps(document) {
  if (!isRecord(document)) {
    return
  }
  const workflowDefault = document.defaults?.run?.['working-directory']
  const jobs = isRecord(document.jobs) ? Object.values(document.jobs) : []
  for (const job of jobs) {
    if (!isRecord(job)) {
      continue
    }
    const jobDefault = job.defaults?.run?.['working-directory'] ?? workflowDefault
    for (const step of Array.isArray(job.steps) ? job.steps : []) {
      if (isRecord(step) && typeof step.run === 'string') {
        yield { run: step.run, cwd: step['working-directory'] ?? jobDefault }
      }
    }
  }
  // Composite actions keep their steps under `runs.steps` and are invoked by workflows via `uses`.
  for (const step of Array.isArray(document.runs?.steps) ? document.runs.steps : []) {
    if (isRecord(step) && typeof step.run === 'string') {
      yield { run: step.run, cwd: step['working-directory'] ?? workflowDefault }
    }
  }
}

/**
 * Pull the script names and script files a shell snippet invokes.
 *
 * Names are matched by EXACT equality after splitting on shell separators, never by substring:
 * `audit:code-quality` is a strict prefix of `audit:code-quality:native`, and `typecheck` of seven
 * siblings, so a substring match credits an unwired parent for its child's step.
 */
export function extractInvocations(runText) {
  const names = new Set()
  const files = new Set()
  for (const segment of runText.split(/&&|\|\||[;|\n]|\$\(/)) {
    const named = segment.match(/^\s*(?:[A-Z_][A-Z0-9_]*=\S*\s+)*pnpm\s+(?:run\s+|exec\s+)?([\w@:.-]+)/)
    if (named) {
      names.add(named[1])
    }
    const file = segment.match(/(?:^|\s)(?:node|tsx)\s+([^\s]+\.(?:mjs|cjs|js|ts))(?:\s|$)/)
    if (file) {
      files.add(file[1].replace(/\\/g, '/'))
    }
  }
  return { names, files }
}

// Why: only the file a node/tsx step executes is evidence; flags and trailing arguments are not.
export function extractScriptTarget(command) {
  if (typeof command !== 'string') {
    return null
  }
  const match = command.match(/(?:^|\s)(?:node|tsx)\s+([^\s]+\.(?:mjs|cjs|js|ts))(?:\s|$)/)
  return match ? match[1].replace(/\\/g, '/') : null
}

export function buildCoverageIndex(documents) {
  const names = new Set()
  const files = new Set()
  for (const document of documents) {
    for (const step of iterateRunSteps(document)) {
      if (!isRootWorkingDirectory(step.cwd)) {
        continue
      }
      const found = extractInvocations(step.run)
      for (const name of found.names) {
        names.add(name)
      }
      for (const file of found.files) {
        files.add(file)
      }
    }
  }
  return { names, files }
}

/**
 * Expand the invoked-name set through package.json script chains.
 *
 * A gate chained into a script CI actually runs does gate CI: `pnpm run build:release` is a step in
 * the packaging job, and the gate inside it fails that step. Expansion starts ONLY from names a
 * workflow invokes, which is what keeps the `lint` hole open on purpose — no workflow runs
 * `pnpm lint`, so it is never an entry point and the gates chained into it stay debt.
 *
 * Names only, never the `node <file>` targets inside a script body. `build:cli` runs
 * verify-cli-bin.mjs with --fix-executable --fix-package-json, which REPAIRS two of the things the
 * bare gate refuses: same file, different contract, so it is not the same gate having run.
 */
export function expandChainedInvocations(invokedNames, scripts) {
  const resolved = new Set(invokedNames)
  const queue = [...invokedNames]
  while (queue.length > 0) {
    const command = scripts?.[queue.pop()]
    if (typeof command !== 'string') {
      continue
    }
    for (const next of extractInvocations(command).names) {
      if (!resolved.has(next)) {
        resolved.add(next)
        queue.push(next)
      }
    }
  }
  return resolved
}

export function isCovered(scriptName, scriptCommand, index) {
  if (index.names.has(scriptName)) {
    return true
  }
  const target = extractScriptTarget(scriptCommand)
  return target !== null && index.files.has(target)
}

/**
 * Baseline lines are `script-name  # reason`. A reason is mandatory: an exemption nobody can
 * evaluate later is a permanent excuse rather than recorded debt.
 */
export function parseBaseline(raw) {
  const entries = new Map()
  const malformed = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue
    }
    const match = trimmed.match(/^(\S+)\s*#\s*(.+?)\s*$/)
    if (!match) {
      malformed.push(trimmed)
      continue
    }
    entries.set(match[1], match[2])
  }
  return { entries, malformed }
}

export function extractBaselineHeader(raw) {
  const header = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('#')) {
      break
    }
    header.push(line)
  }
  return header.length > 0 ? `${header.join('\n')}\n` : ''
}

/**
 * Three refusals, and the third keeps the ratchet turning: a new unwired gate is refused, a
 * recorded exemption may not outlive its debt, and an exemption naming a script that no longer
 * exists is removed so the list cannot describe a vanished estate.
 */
export function evaluateCoverage({ gateScripts, scripts, index, baseline }) {
  const failures = []
  const uncovered = []
  for (const name of gateScripts) {
    if (isCovered(name, scripts[name], index)) {
      if (baseline.has(name)) {
        failures.push(
          `${name}: now invoked by a workflow, so its ${BASELINE_PATH} entry is stale; ` +
            `remove it (node config/scripts/check-ci-gate-coverage.mjs --prune)`
        )
      }
      continue
    }
    uncovered.push(name)
    if (!baseline.has(name)) {
      failures.push(
        `${name}: nothing under ${WORKFLOW_DIR} or ${ACTION_DIR} invokes it, so it gates nothing ` +
          `in CI; add it to a workflow, or record it in ${BASELINE_PATH} with a reason`
      )
    }
  }
  for (const name of baseline.keys()) {
    if (!gateScripts.includes(name)) {
      failures.push(
        `${name}: recorded in ${BASELINE_PATH} but is no longer a gate script in package.json; ` +
          `remove the stale entry`
      )
    }
  }
  return { failures, uncovered }
}

export function resolveVerdict({ failures, internalFailures }) {
  if (internalFailures.length > 0) {
    return { verdict: VERDICT_CHECKER_INTERNAL_FAILURE, code: 2 }
  }
  if (failures.length > 0) {
    return { verdict: VERDICT_CONTRACT_INVALID, code: 1 }
  }
  return { verdict: VERDICT_CONTRACT_VALID, code: 0 }
}

async function collectYamlFiles(root, relativeDir) {
  const absolute = path.join(root, relativeDir)
  const found = []
  let entries
  try {
    entries = await fs.readdir(absolute, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return found
    }
    throw error
  }
  for (const entry of entries) {
    const child = path.join(relativeDir, entry.name)
    if (entry.isDirectory()) {
      found.push(...(await collectYamlFiles(root, child)))
    } else if (/\.ya?ml$/.test(entry.name)) {
      found.push(child)
    }
  }
  return found
}

async function readDefinitions(root) {
  const files = [
    ...(await collectYamlFiles(root, WORKFLOW_DIR)),
    ...(await collectYamlFiles(root, ACTION_DIR))
  ]
  const documents = []
  const unparsed = []
  for (const file of files) {
    const raw = await fs.readFile(path.join(root, file), 'utf8')
    try {
      documents.push(parseYaml(raw))
    } catch (error) {
      unparsed.push(`${file}: ${error.message}`)
    }
  }
  return { documents, unparsed, count: files.length }
}

async function pruneBaseline(root, gateScripts, scripts, index) {
  const baselinePath = path.join(root, BASELINE_PATH)
  let raw
  try {
    raw = await fs.readFile(baselinePath, 'utf8')
  } catch (error) {
    console.error(`${BASELINE_PATH}: unable to read (${error.message})`)
    return 1
  }
  const { entries } = parseBaseline(raw)
  const kept = []
  for (const [name, reason] of entries) {
    if (!gateScripts.includes(name) || isCovered(name, scripts[name], index)) {
      continue
    }
    kept.push(`${name}  # ${reason}`)
  }
  await fs.writeFile(baselinePath, `${extractBaselineHeader(raw)}${kept.sort().join('\n')}\n`, 'utf8')
  console.log(`${BASELINE_PATH}: ${entries.size} entr(ies) -> ${kept.length} after pruning.`)
  return 0
}

/**
 * `minimumGateScripts` and `minimumWorkflowFiles` exist so a synthetic fixture can hold a handful
 * of files without tripping the floors. Production callers pass nothing; a drill pins the defaults
 * so this seam cannot quietly become the way a floor is lowered.
 */
export async function main(
  root = process.cwd(),
  {
    minimumGateScripts = MINIMUM_GATE_SCRIPTS,
    minimumWorkflowFiles = MINIMUM_WORKFLOW_FILES
  } = {}
) {
  let manifest
  try {
    manifest = JSON.parse(await fs.readFile(path.join(root, PACKAGE_PATH), 'utf8'))
  } catch (error) {
    console.error(`${PACKAGE_PATH}: unable to read or parse (${error.message})`)
    console.error(`Verdict: ${VERDICT_UNREADABLE_INPUT}`)
    return 1
  }

  const internalFailures = []
  const scripts = isRecord(manifest.scripts) ? manifest.scripts : {}
  const gateScripts = collectGateScripts(scripts)

  let definitions
  try {
    definitions = await readDefinitions(root)
  } catch (error) {
    // Why exit 2: unreadable definitions means coverage could not be judged. Reporting every gate
    // as uncovered would blame the subject for the instrument being blind.
    console.error(`unable to read CI definitions (${error.message})`)
    console.error(`Verdict: ${VERDICT_CHECKER_INTERNAL_FAILURE}`)
    return 2
  }
  for (const failure of definitions.unparsed) {
    internalFailures.push(`could not parse ${failure}`)
  }
  if (definitions.count < minimumWorkflowFiles) {
    internalFailures.push(
      `swept ${definitions.count} CI definition file(s), expected at least ${minimumWorkflowFiles}; ` +
        `the sweep may have stopped seeing ${WORKFLOW_DIR}`
    )
  }
  if (gateScripts.length < minimumGateScripts) {
    internalFailures.push(
      `found ${gateScripts.length} gate script(s), expected at least ${minimumGateScripts}; ` +
        `the enumerator may have stopped seeing package.json scripts`
    )
  }

  let baseline = new Map()
  try {
    let raw = ''
    try {
      raw = await fs.readFile(path.join(root, BASELINE_PATH), 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error
      }
    }
    const parsed = parseBaseline(raw)
    if (parsed.malformed.length > 0) {
      internalFailures.push(
        `${BASELINE_PATH}: ${parsed.malformed.length} line(s) are not "name  # reason" ` +
          `(first: ${parsed.malformed[0]})`
      )
    }
    baseline = parsed.entries
  } catch (error) {
    internalFailures.push(`${BASELINE_PATH}: unable to read (${error.message})`)
  }

  const index = buildCoverageIndex(definitions.documents)
  index.names = expandChainedInvocations(index.names, scripts)

  if (process.argv.includes('--prune')) {
    return await pruneBaseline(root, gateScripts, scripts, index)
  }

  let failures = []
  let uncovered = []
  if (internalFailures.length === 0) {
    try {
      const result = evaluateCoverage({ gateScripts, scripts, index, baseline })
      failures = result.failures
      uncovered = result.uncovered
    } catch (error) {
      internalFailures.push(`the checker threw while judging coverage (${error.message})`)
    }
  }

  const { verdict, code } = resolveVerdict({ failures, internalFailures })
  for (const failure of failures) {
    console.error(`- ${failure}`)
  }
  for (const failure of internalFailures) {
    console.error(`! ${failure}`)
  }
  if (code === 0) {
    console.log(
      `CI gate coverage: ${gateScripts.length} gate script(s) across ${definitions.count} CI ` +
        `definition(s), ${gateScripts.length - uncovered.length} invoked, ${uncovered.length} recorded as debt.`
    )
    return 0
  }
  console.error(`Verdict: ${verdict}`)
  return code
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main())
}
