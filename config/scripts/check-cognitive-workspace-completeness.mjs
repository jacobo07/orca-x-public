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
const RELIABILITY_PATH = 'config/reliability-gates.jsonc'
const ROADMAP_PATH = '.planning/ROADMAP.md'
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
const RUNGS = new Set(['unit', 'integration', 'real-electron', 'real-remote-host', 'real-provider'])
const GATE_COMMAND = /^node\s+(config\/scripts\/[\w.-]+\.mjs)((?:\s+[\w.:=-]+)*)\s*$/
const ROADMAP_ENTRY = /^- \[[ xX]\] \*\*Phase (\d+(?:\.\d+)*): (.+?)\*\*/

/** Only a plain node gate may be named, so completeness can never execute an arbitrary command. */
export function parseGateCommand(command) {
  const match = typeof command === 'string' ? GATE_COMMAND.exec(command.trim()) : null
  if (!match) {
    return null
  }
  return { file: match[1], args: match[2].trim() ? match[2].trim().split(/\s+/) : [] }
}

/** Only the checklist counts; `### Phase N` detail headings describe, they do not declare. */
export function parseRoadmapPhases(text) {
  const phases = new Map()
  for (const line of String(text).split(/\r?\n/)) {
    const match = ROADMAP_ENTRY.exec(line.trim())
    if (match) {
      phases.set(match[1], match[2].trim())
    }
  }
  return phases
}

const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0
const isPathShaped = (value) => nonEmpty(value) && /[\\/]/.test(value) && !/\s/.test(value)

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

function resolveContains(file, needle, what, context) {
  if (!nonEmpty(file) || !nonEmpty(needle)) {
    return `${what} evidence needs a file and the text it must contain`
  }
  if (!context.trackedFiles.has(file)) {
    return `${what} evidence names ${file}, which is not tracked`
  }
  const source = context.readTracked(file)
  if (source === null || !source.includes(needle)) {
    return `${file} does not contain the ${what === 'doc' ? 'text' : 'title'} "${needle}"`
  }
  return null
}

const RESOLVERS = {
  gate: resolveGate,
  test: (entry, context) => resolveContains(entry.file, entry.title, 'test', context),
  doc: (entry, context) => resolveContains(entry.file, entry.contains, 'doc', context),
  'product-reality': (entry, context) =>
    RUNGS.has(entry.rung)
      ? resolveContains(entry.spec, entry.title, 'product-reality', context)
      : `product-reality rung "${entry.rung}" is not one of ${[...RUNGS].join(', ')}`,
  'reliability-gate': (entry, context) =>
    context.reliabilityGateIds.has(entry.id)
      ? null
      : `reliability gate "${entry.id}" is not in ${RELIABILITY_PATH}`
}

function checkRow(row, context, phaseNumbers, failures) {
  const label = `row ${row?.id ?? '?'}`
  const required = REQUIRED_DIMENSIONS.find((dimension) => dimension.id === row?.id)
  if (!required) {
    failures.push(`${label} is not a required dimension (A..T); a stale or misspelled row`)
  } else if (row.dimension !== required.key) {
    failures.push(`${label} has dimension "${row.dimension}", expected "${required.key}"`)
  }
  for (const field of ['owner', 'claim']) {
    if (!nonEmpty(row?.[field])) {
      failures.push(`${label} has no ${field}`)
    }
  }
  if (isPathShaped(row?.owner) && !context.trackedFiles.has(row.owner)) {
    failures.push(`${label} names owner ${row.owner}, which is not tracked`)
  }
  if (!STATES.has(row?.state)) {
    failures.push(`${label} has state "${row?.state}", expected complete, open or blocked`)
  }
  if (!phaseNumbers.has(String(row?.phase))) {
    failures.push(`${label} names phase "${row?.phase}", which is not in the phases table`)
  }
  const evidence = Array.isArray(row?.evidence) ? row.evidence : null
  if (evidence === null) {
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
  if (row?.state === 'complete' && evidence !== null) {
    if (evidence.length === 0) {
      failures.push(`${label} is complete with no evidence`)
    } else if (evidence.every((entry) => entry?.kind === 'doc')) {
      failures.push(
        `${label} is complete on doc evidence alone; a complete row needs evidence that is not a document`
      )
    }
  }
}

function crossCheckRoadmap(matrix, roadmapPhases, failures) {
  const declared = new Map(
    (matrix?.phases ?? []).map((phase) => [String(phase.number), phase.title])
  )
  for (const [number, title] of declared) {
    if (!roadmapPhases.has(number)) {
      failures.push(`phase ${number} ("${title}") is in the matrix but not in the roadmap`)
    } else if (roadmapPhases.get(number) !== title) {
      failures.push(
        `phase ${number} is titled "${title}" in the matrix but "${roadmapPhases.get(number)}" in the roadmap`
      )
    }
  }
  for (const [number, title] of roadmapPhases) {
    if (!declared.has(number)) {
      failures.push(`phase ${number} ("${title}") is in the roadmap but not in the matrix`)
    }
  }
}

/** Pure: judges a parsed matrix against a repository snapshot supplied in `context`. */
export function verifyMatrix(matrix, context) {
  const failures = []
  const rows = Array.isArray(matrix?.rows) ? matrix.rows : []
  const phaseNumbers = new Set((matrix?.phases ?? []).map((phase) => String(phase.number)))
  const counts = { complete: 0, open: 0, blocked: 0 }
  const kinds = {}
  const rungs = {}
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
  for (const [id, seen] of byId) {
    if (seen > 1) {
      failures.push(`row ${id} appears ${seen} times`)
    }
  }
  if (rows.length < ROW_FLOOR) {
    failures.push(`found ${rows.length} rows, expected at least ${ROW_FLOOR}`)
  }

  for (const row of rows) {
    checkRow(row, context, phaseNumbers, failures)
    if (STATES.has(row?.state)) {
      counts[row.state] += 1
    }
    // Every pointer must resolve whatever the state: a rotted pointer on an open row is still rotted.
    for (const entry of Array.isArray(row?.evidence) ? row.evidence : []) {
      total += 1
      kinds[entry?.kind] = (kinds[entry?.kind] ?? 0) + 1
      const resolve = RESOLVERS[entry?.kind]
      const problem = resolve ? resolve(entry, context) : `unknown evidence kind "${entry?.kind}"`
      if (problem) {
        failures.push(`row ${row?.id ?? '?'}: ${problem}`)
      } else {
        resolved += 1
        if (entry.kind === 'product-reality') {
          rungs[entry.rung] = (rungs[entry.rung] ?? 0) + 1
        }
      }
    }
  }

  if (context.roadmapPhases) {
    crossCheckRoadmap(matrix, context.roadmapPhases, failures)
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
      rungs,
      counts,
      roadmapCrossCheck: context.roadmapPhases ? 'ran' : 'not-run',
      roadmapPhaseCount: context.roadmapPhases?.size ?? 0
    }
  }
}

/** The gate's own red and green subjects, so it stays falsifiable the day the last real row closes. */
export function selfControlsAnswerCorrectly() {
  const script = 'config/scripts/self-control-gate.mjs'
  const complete = {
    phases: [{ number: '1', title: 'self' }],
    rows: REQUIRED_DIMENSIONS.map(({ id, key }) => ({
      id,
      dimension: key,
      owner: 'self-control owner',
      state: 'complete',
      phase: '1',
      claim: 'self-control claim',
      evidence: [{ kind: 'gate', script: 'check:self-control' }]
    }))
  }
  const context = {
    packageScripts: { 'check:self-control': `node ${script}` },
    trackedFiles: new Set([script]),
    readTracked: () => null,
    reliabilityGateIds: new Set(),
    roadmapPhases: null,
    selfCommandFile: SELF_PATH
  }
  const missingOne = { ...complete, rows: complete.rows.slice(1) }
  const green = verifyMatrix(complete, context).failures.length === 0
  const red = verifyMatrix(missingOne, context).failures.includes(
    `missing required dimension ${REQUIRED_DIMENSIONS[0].id} (${REQUIRED_DIMENSIONS[0].key})`
  )
  return green && red
}

function describeAperture(aperture) {
  const list = (record) =>
    Object.entries(record)
      .map(([name, count]) => `${name} ${count}`)
      .join(', ') || 'none'
  const { complete, open, blocked } = aperture.counts
  const roadmap =
    aperture.roadmapCrossCheck === 'ran'
      ? `roadmap cross-check: ran (${aperture.roadmapPhaseCount} phases)`
      : `roadmap cross-check: NOT RUN (${ROADMAP_PATH} not in this checkout)`
  return `${aperture.rows} rows, ${aperture.required} required, evidence resolved ${aperture.resolved}/${aperture.total} (${list(aperture.kinds)}), product-reality rungs (${list(aperture.rungs)}), ${complete} complete / ${open} open / ${blocked} blocked, ${roadmap}`
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
    if (isPathShaped(row?.owner)) {
      paths.add(row.owner)
    }
    for (const entry of row?.evidence ?? []) {
      const parsed = entry?.kind === 'gate' ? parseGateCommand(scripts[entry.script]) : null
      const file = parsed?.file ?? entry?.file ?? entry?.spec
      if (nonEmpty(file)) {
        paths.add(file)
      }
    }
  }
  return [...paths]
}

async function readOptional(file) {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

/** Runs only the gates of COMPLETE rows: an open row's evidence is progress, not a claim. */
export async function judgeGateRuns(rows, packageScripts, runGate) {
  const failures = []
  const cannotJudge = []
  const executed = []
  for (const row of rows) {
    if (row?.state !== 'complete') {
      continue
    }
    for (const entry of row.evidence ?? []) {
      const gate = entry?.kind === 'gate' ? parseGateCommand(packageScripts[entry.script]) : null
      if (!gate) {
        continue
      }
      const outcome = await runGate(gate)
      if (!outcome?.ran) {
        cannotJudge.push(
          `row ${row.id}: gate ${entry.script} did not run (${outcome?.reason ?? 'unknown'})`
        )
        continue
      }
      executed.push(`${entry.script} → exit ${outcome.exitCode}`)
      if (outcome.exitCode !== 0) {
        failures.push(`row ${row.id}: gate ${entry.script} exited ${outcome.exitCode}`)
      }
    }
  }
  return { failures, cannotJudge, executed }
}

export function formatOpenRows(openRows) {
  return openRows.map((row) => `${row.id} (${row.dimension}) — phase ${row.phase}: ${row.closes}`)
}

/** A verifier that could not judge outranks a subject that failed: its run proves nothing. */
export function decideCompleteness({
  integrityFailures,
  roadmapRan,
  gateFailures,
  cannotJudge,
  openRows
}) {
  if (cannotJudge.length > 0 || !roadmapRan) {
    return { exitCode: 2 }
  }
  if (integrityFailures.length > 0 || gateFailures.length > 0 || openRows.length > 0) {
    return { exitCode: 1 }
  }
  return { exitCode: 0 }
}

function runGateIn(root) {
  return async (gate) => {
    try {
      await run(process.execPath, [gate.file, ...gate.args], { cwd: root, timeout: 120_000 })
      return { ran: true, exitCode: 0 }
    } catch (error) {
      if (typeof error?.code === 'number') {
        return { ran: true, exitCode: error.code }
      }
      return {
        ran: false,
        reason: error?.killed ? 'timed out' : (error?.code ?? error?.message ?? 'spawn failed')
      }
    }
  }
}

export async function main(root = process.cwd(), log = console, argv = process.argv.slice(2)) {
  const fail = (message) => {
    log.error(`❌  check-cognitive-workspace-completeness: ${message}`)
    return 2
  }
  // A typo must never silently change which gate ran.
  const unknown = argv.filter((arg) => arg !== '--integrity')
  if (unknown.length > 0 || argv.length > 1) {
    return fail(`usage: [--integrity] (got ${argv.join(' ')})`)
  }
  const integrityOnly = argv.includes('--integrity')
  if (!selfControlsAnswerCorrectly()) {
    return fail('the instrument cannot tell a complete matrix from one missing a dimension')
  }

  let matrixText
  try {
    matrixText = await readFile(path.join(root, MATRIX_PATH), 'utf8')
  } catch (error) {
    return fail(`cannot read ${MATRIX_PATH}: ${error.message}`)
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
  const reliability = parse(await readFile(path.join(root, RELIABILITY_PATH), 'utf8'), [], {
    allowTrailingComma: true
  })
  const reliabilityGateIds = new Set((reliability?.gates ?? []).map((gate) => gate?.id))
  if (reliabilityGateIds.size === 0) {
    return fail(`read no gate ids from ${RELIABILITY_PATH}`)
  }
  const roadmapText = await readOptional(path.join(root, ROADMAP_PATH))

  const paths = evidencePaths(matrix, packageScripts)
  const tracked =
    paths.length > 0 ? await gitLines(root, ['ls-files', '-z', '--', ...paths]) : { lines: [] }
  if (tracked.lines === null) {
    return fail(`could not list tracked files: ${tracked.error}`)
  }
  const trackedFiles = new Set(tracked.lines)
  const sources = new Map()
  for (const file of trackedFiles) {
    sources.set(file, await readOptional(path.join(root, file)))
  }

  const result = verifyMatrix(matrix, {
    packageScripts,
    trackedFiles,
    readTracked: (file) => sources.get(file) ?? null,
    reliabilityGateIds,
    roadmapPhases: roadmapText === null ? null : parseRoadmapPhases(roadmapText),
    selfCommandFile: SELF_PATH
  })
  const aperture = describeAperture(result.aperture)
  const list = (lines) => {
    for (const line of lines) {
      log.error(`    - ${line}`)
    }
  }
  if (integrityOnly) {
    if (result.failures.length > 0) {
      log.error(`❌  check-cognitive-workspace-completeness --integrity (${aperture}):`)
      list(result.failures)
      return 1
    }
    log.log(`✅  check-cognitive-workspace-completeness --integrity: ${aperture}.`)
    return 0
  }

  const gates = await judgeGateRuns(result.rows, packageScripts, runGateIn(root))
  const verdict = decideCompleteness({
    integrityFailures: result.failures,
    roadmapRan: result.aperture.roadmapCrossCheck === 'ran',
    gateFailures: gates.failures,
    cannotJudge: gates.cannotJudge,
    openRows: result.open
  })
  const executed = `gates executed: ${gates.executed.join(', ') || 'none'}`
  if (verdict.exitCode === 0) {
    log.log(
      `✅  check-cognitive-workspace-completeness: the program is complete — ${aperture}; ${executed}.`
    )
    return 0
  }
  const heading =
    verdict.exitCode === 2 ? 'could not judge completeness' : 'the program is not complete'
  log.error(`❌  check-cognitive-workspace-completeness: ${heading} (${aperture}; ${executed}):`)
  if (result.aperture.roadmapCrossCheck !== 'ran') {
    list([
      `the roadmap cross-check did not run (${ROADMAP_PATH} is absent), so completion cannot be judged`
    ])
  }
  list(gates.cannotJudge)
  list(result.failures)
  list(gates.failures)
  if (result.open.length > 0) {
    log.error(`    open rows (${result.open.length}):`)
    list(formatOpenRows(result.open))
  }
  return verdict.exitCode
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(await main())
}
