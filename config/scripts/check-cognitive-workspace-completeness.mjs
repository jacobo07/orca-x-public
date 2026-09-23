import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

import { parse } from 'jsonc-parser'

const run = promisify(execFile)

// Is the Cognitive Workspace program done?
//
// That answer used to live in a checklist in an untracked roadmap, which cannot fail. This gate turns
// it into a claim a machine checks: every dimension the program owes is a row, a row may only be
// `complete` on evidence that resolves against the repository, and the done-gate is red while any
// row is open. `--integrity` checks the matrix without demanding completion, so it is safe on PRs.

const MATRIX_PATH = 'config/cognitive-workspace-completeness.jsonc'
const SELF_PATH = 'config/scripts/check-cognitive-workspace-completeness.mjs'

/** The verifier owns the list, so deleting a row from the matrix cannot delete the obligation. */
export const REQUIRED_DIMENSIONS = Object.freeze(
  [
    ['A', 'agent-identity'],
    ['B', 'project-ownership'],
    ['C', 'located-effect'],
    ['D', 'provider-instruction-layer'],
    ['E', 'provider-execution-location'],
    ['F', 'conversation-durability'],
    ['G', 'remote-execution'],
    ['H', 'multi-project-safety'],
    ['I', 'worktree-dirty-state'],
    ['J', 'user-facing-states'],
    ['K', 'cli-ipc-frontend-coherence'],
    ['L', 'security'],
    ['M', 'observability'],
    ['N', 'token-economics'],
    ['O', 'failure-recovery'],
    ['P', 'device-independent-projection'],
    ['Q', 'product-reality'],
    ['R', 'baseline-inheritance'],
    ['S', 'knowledge-ukdl'],
    ['T', 'ci']
  ].map(([id, key]) => Object.freeze({ id, key }))
)
/** A floor in the matrix could be lowered by the same edit that deletes a row. */
export const ROW_FLOOR = REQUIRED_DIMENSIONS.length

const STATES = new Set(['complete', 'open', 'blocked'])
const BLOCKER_CLASSES = new Set(['owner-auth', 'runner-capacity'])
const GATE_COMMAND = /^node\s+(config\/scripts\/[\w.-]+\.mjs)((?:\s+[\w.:=-]+)*)\s*$/

/** Only a plain node gate may be named, so completeness can never execute an arbitrary command. */
export function parseGateCommand(command) {
  const match = typeof command === 'string' ? GATE_COMMAND.exec(command.trim()) : null
  if (!match) {
    return null
  }
  return { file: match[1], args: match[2].trim() ? match[2].trim().split(/\s+/) : [] }
}

const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0

function resolveGate(entry, context) {
  const command = context.packageScripts[entry.script]
  if (command === undefined) {
    return `gate script "${entry.script}" is not in package.json`
  }
  const parsed = parseGateCommand(command)
  if (!parsed) {
    return `gate script "${entry.script}" is not a plain \`node config/scripts/*.mjs\` command`
  }
  if (parsed.file === context.selfCommandFile) {
    return `gate script "${entry.script}" is this verifier — a gate cannot be its own evidence`
  }
  if (!context.trackedFiles.has(parsed.file)) {
    return `gate script "${entry.script}" runs ${parsed.file}, which is not tracked`
  }
  return null
}

const RESOLVERS = { gate: resolveGate }

/** Pure: judges a parsed matrix against a repository snapshot supplied in `context`. */
export function verifyMatrix(matrix, context) {
  const failures = []
  const rows = Array.isArray(matrix?.rows) ? matrix.rows : []
  const phaseNumbers = new Set((matrix?.phases ?? []).map((phase) => String(phase.number)))
  const counts = { complete: 0, open: 0, blocked: 0 }
  const kinds = {}
  let resolved = 0
  let total = 0

  const byId = new Map()
  for (const row of rows) {
    byId.set(row?.id, (byId.get(row?.id) ?? 0) + 1)
  }
  for (const { id, key } of REQUIRED_DIMENSIONS) {
    if (!byId.has(id)) {
      failures.push(`missing required dimension ${id} (${key})`)
    }
  }
  if (rows.length < ROW_FLOOR) {
    failures.push(`found ${rows.length} rows, expected at least ${ROW_FLOOR}`)
  }

  for (const row of rows) {
    const label = `row ${row?.id ?? '?'}`
    const required = REQUIRED_DIMENSIONS.find((dimension) => dimension.id === row?.id)
    if (required && row.dimension !== required.key) {
      failures.push(`${label} has dimension "${row.dimension}", expected "${required.key}"`)
    }
    for (const field of ['owner', 'claim']) {
      if (!nonEmpty(row?.[field])) {
        failures.push(`${label} has no ${field}`)
      }
    }
    if (!STATES.has(row?.state)) {
      failures.push(`${label} has state "${row?.state}", expected complete, open or blocked`)
    } else {
      counts[row.state] += 1
    }
    if (!phaseNumbers.has(String(row?.phase))) {
      failures.push(`${label} names phase "${row?.phase}", which is not in the phases table`)
    }
    if (!Array.isArray(row?.evidence)) {
      failures.push(`${label} has no evidence array`)
    }

    if (row?.state === 'blocked') {
      if (!BLOCKER_CLASSES.has(row.blocker?.class)) {
        failures.push(
          `${label} is blocked by "${row.blocker?.class}", but only owner-auth and runner-capacity may block — anything else is open engineering`
        )
      }
      if (!nonEmpty(row.blocker?.precondition)) {
        failures.push(`${label} is blocked without a precondition sentence`)
      }
    } else if (row?.blocker !== undefined) {
      failures.push(`${label} carries a blocker but is ${row?.state}`)
    }
    if (row?.state === 'open' && !nonEmpty(row.closes)) {
      failures.push(`${label} is open without saying what closes it`)
    }

    for (const entry of Array.isArray(row?.evidence) ? row.evidence : []) {
      total += 1
      kinds[entry?.kind] = (kinds[entry?.kind] ?? 0) + 1
      const resolve = RESOLVERS[entry?.kind]
      const problem = resolve ? resolve(entry, context) : `unknown evidence kind "${entry?.kind}"`
      if (problem) {
        failures.push(`${label}: ${problem}`)
      } else {
        resolved += 1
      }
    }
  }

  return {
    failures,
    rows,
    open: rows.filter((row) => row?.state === 'open'),
    blocked: rows.filter((row) => row?.state === 'blocked'),
    aperture: {
      rows: rows.length,
      required: REQUIRED_DIMENSIONS.length,
      resolved,
      total,
      kinds,
      counts
    }
  }
}

function describeAperture(aperture) {
  const kinds =
    Object.entries(aperture.kinds)
      .map(([kind, count]) => `${kind} ${count}`)
      .join(', ') || 'none'
  const { complete, open, blocked } = aperture.counts
  return `${aperture.rows} rows, ${aperture.required} required, evidence resolved ${aperture.resolved}/${aperture.total} (${kinds}), ${complete} complete / ${open} open / ${blocked} blocked`
}

async function gitLines(root, args) {
  try {
    const { stdout } = await run('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 })
    return {
      lines: stdout
        .split('\0')
        .map((line) => line.trim())
        .filter(Boolean)
    }
  } catch (error) {
    return { lines: null, error: error?.shortMessage ?? error?.message ?? String(error) }
  }
}

function evidencePaths(matrix, scripts) {
  const paths = new Set()
  for (const row of matrix?.rows ?? []) {
    if (nonEmpty(row?.owner) && /[\\/]/.test(row.owner) && !/\s/.test(row.owner)) {
      paths.add(row.owner)
    }
    for (const entry of row?.evidence ?? []) {
      if (entry?.kind === 'gate') {
        const parsed = parseGateCommand(scripts[entry.script])
        if (parsed) {
          paths.add(parsed.file)
        }
      }
    }
  }
  return [...paths]
}

export async function main(root = process.cwd(), log = console, argv = process.argv.slice(2)) {
  const unknown = argv.filter((arg) => arg !== '--integrity')
  if (unknown.length > 0 || argv.length === 0) {
    log.error(
      `❌  check-cognitive-workspace-completeness: usage: --integrity (got ${argv.join(' ') || 'no argument'})`
    )
    return 2
  }

  let matrixText
  try {
    matrixText = await readFile(path.join(root, MATRIX_PATH), 'utf8')
  } catch (error) {
    log.error(
      `❌  check-cognitive-workspace-completeness: cannot read ${MATRIX_PATH}: ${error.message}`
    )
    return 2
  }
  const errors = []
  const matrix = parse(matrixText, errors, { allowTrailingComma: true })
  if (errors.length > 0 || matrix === null || typeof matrix !== 'object') {
    log.error(
      `❌  check-cognitive-workspace-completeness: ${MATRIX_PATH} does not parse (${errors.length} errors)`
    )
    return 1
  }
  const packageScripts =
    JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).scripts ?? {}

  const paths = evidencePaths(matrix, packageScripts)
  const tracked =
    paths.length > 0 ? await gitLines(root, ['ls-files', '-z', '--', ...paths]) : { lines: [] }
  if (tracked.lines === null) {
    log.error(
      `❌  check-cognitive-workspace-completeness: could not list tracked files: ${tracked.error}`
    )
    return 2
  }

  const result = verifyMatrix(matrix, {
    packageScripts,
    trackedFiles: new Set(tracked.lines),
    selfCommandFile: SELF_PATH
  })
  const aperture = describeAperture(result.aperture)
  if (result.failures.length > 0) {
    log.error(`❌  check-cognitive-workspace-completeness --integrity (${aperture}):`)
    for (const failure of result.failures) {
      log.error(`    - ${failure}`)
    }
    return 1
  }
  log.log(`✅  check-cognitive-workspace-completeness --integrity: ${aperture}.`)
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(await main())
}
