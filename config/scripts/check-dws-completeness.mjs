import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { parse, printParseErrorCode } from 'jsonc-parser'

import { isEntryPoint } from './check-mobile-capability-aperture.mjs'

/**
 * The dws program's one executable done-gate.
 *
 * Reads config/dws-completion-matrix.jsonc (never .planning/workstreams/dws/MATRIX.md, which is
 * git-excluded and unreadable on any other checkout) and refuses while any required row is not
 * PASS. A PASS must cite evidence that RESOLVES — an existing file, or a package.json gate script
 * — never a bare claim, and never a Stage-Zero-seeded state nobody re-measured against this
 * worktree. This gate is red BY DESIGN until every row is a measured PASS; it is deliberately not
 * wired into any CI workflow (see config/ci-gate-coverage-baseline.txt).
 */

export const MATRIX_PATH = 'config/dws-completion-matrix.jsonc'
export const PACKAGE_PATH = 'package.json'

// Why: a parser that silently stopped seeing rows reports a short, clean matrix. The floor forces
// it to prove it could still see all 55 before its verdict is trusted.
export const MINIMUM_ROWS = 55

export const ROW_STATES = Object.freeze(['PASS', 'PARTIAL', 'ABSENT', 'BLOCKED', 'UNKNOWN', 'NAMED_DEBT'])
export const STATE_SOURCES = Object.freeze(['stage-zero-seed', 'measured'])
export const EVIDENCE_KINDS = Object.freeze(['file', 'gate', 'commit'])

export const VERDICT_CONTRACT_VALID = 'CONTRACT VALID'
export const VERDICT_CONTRACT_INVALID = 'CONTRACT INVALID'
export const VERDICT_UNREADABLE_INPUT = 'UNREADABLE INPUT'
export const VERDICT_CHECKER_INTERNAL_FAILURE = 'CHECKER INTERNAL FAILURE'

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function isIntegerArray(value) {
  return Array.isArray(value) && value.every((item) => Number.isInteger(item))
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function pathEscapesCheckout(relativePath) {
  return path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')
}

/**
 * Schema problems for one row. A row failing any of these is a CHECKER INTERNAL FAILURE, not a
 * contract failure: the matrix itself is malformed, so nothing about its contract can be judged.
 */
export function validateRow(row) {
  const problems = []
  if (!isRecord(row)) {
    return ['row must be an object']
  }
  if (!Number.isInteger(row.id) || row.id <= 0) {
    problems.push('id must be a positive integer')
  }
  if (!nonEmptyString(row.row)) {
    problems.push('row must be a non-empty string')
  }
  if (!nonEmptyString(row.owner)) {
    problems.push('owner must be a non-empty string')
  }
  if (!nonEmptyString(row.done)) {
    problems.push('done must be a non-empty string')
  }
  if (!ROW_STATES.includes(row.state)) {
    problems.push(`state must be one of ${ROW_STATES.join(', ')}`)
  }
  if (!STATE_SOURCES.includes(row.stateSource)) {
    problems.push(`stateSource must be one of ${STATE_SOURCES.join(', ')}`)
  }
  if (row.stateSource === 'measured') {
    if (!nonEmptyString(row.measuredIn)) {
      problems.push('stateSource "measured" requires a non-empty measuredIn')
    }
    if (typeof row.measuredAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.measuredAt)) {
      problems.push('stateSource "measured" requires measuredAt in YYYY-MM-DD form')
    }
  }
  if (typeof row.required !== 'boolean') {
    problems.push('required must be a boolean')
  }
  if (row.required === false && !nonEmptyString(row.reason)) {
    problems.push('required:false rows need a non-empty reason')
  }
  if (row.state !== undefined && row.state !== 'PASS' && !nonEmptyString(row.reason)) {
    problems.push('non-PASS rows need a non-empty reason')
  }
  if (!isIntegerArray(row.phases)) {
    problems.push('phases must be an integer array')
  }
  if (!isStringArray(row.dependsOn)) {
    problems.push('dependsOn must be a string array')
  }
  if (!Array.isArray(row.evidence)) {
    problems.push('evidence must be an array')
  } else {
    row.evidence.forEach((entry, index) => {
      if (!isRecord(entry) || !EVIDENCE_KINDS.includes(entry.kind)) {
        problems.push(`evidence[${index}]: kind must be one of ${EVIDENCE_KINDS.join(', ')}`)
        return
      }
      if (entry.kind === 'file') {
        if (!nonEmptyString(entry.path)) {
          problems.push(`evidence[${index}]: a "file" entry needs a non-empty path`)
        } else if (pathEscapesCheckout(entry.path)) {
          problems.push(`evidence[${index}]: file path must be relative and may not contain ".." (${entry.path})`)
        }
      } else if (entry.kind === 'gate') {
        if (!nonEmptyString(entry.script)) {
          problems.push(`evidence[${index}]: a "gate" entry needs a non-empty script`)
        }
      } else if (entry.kind === 'commit') {
        if (typeof entry.sha !== 'string' || !/^[0-9a-f]{7,}$/i.test(entry.sha)) {
          problems.push(`evidence[${index}]: a "commit" entry needs a sha of at least 7 hex characters`)
        }
      }
    })
  }
  return problems
}

/**
 * Whether one evidence entry resolves. A commit is never resolvable here: a commit id cannot be
 * checked out on a shallow or foreign checkout, and its presence says nothing about whether the
 * file it names still exists.
 */
export function resolveEvidence(entry, { exists, gateScripts }) {
  if (entry.kind === 'file') {
    const resolved = exists(entry.path)
    return { resolved, detail: resolved ? entry.path : `file not found: ${entry.path}` }
  }
  if (entry.kind === 'gate') {
    const resolved = gateScripts.includes(entry.script)
    return {
      resolved,
      detail: resolved ? entry.script : `gate script not in package.json: ${entry.script}`
    }
  }
  if (entry.kind === 'commit') {
    return { resolved: false, detail: `commit evidence (${entry.sha}) cannot be resolved on this checkout` }
  }
  return { resolved: false, detail: `unknown evidence kind: ${entry.kind}` }
}

/**
 * Judge the whole matrix. Internal failures (malformed schema, population floor, duplicate or
 * non-contiguous ids) skip contract evaluation entirely: a matrix the checker cannot trust to parse
 * correctly cannot be trusted to report its own contract failures either.
 */
export function evaluateMatrix({ matrix, exists, gateScripts, minimumRows }) {
  const internalFailures = []
  const failures = []
  const rows = Array.isArray(matrix?.rows) ? matrix.rows : null

  if (rows === null) {
    internalFailures.push('matrix.rows must be an array')
    return { failures, internalFailures, counts: { total: 0, byState: {}, requiredPass: 0 } }
  }

  if (rows.length < minimumRows) {
    internalFailures.push(
      `parsed ${rows.length} row(s), expected at least ${minimumRows}; the parser may have stopped ` +
        `seeing the matrix`
    )
  }

  for (const row of rows) {
    for (const problem of validateRow(row)) {
      internalFailures.push(`row ${isRecord(row) ? (row.id ?? '?') : '?'}: ${problem}`)
    }
  }

  const ids = rows.map((row) => (isRecord(row) ? row.id : undefined))
  const seen = new Set()
  for (const id of ids) {
    if (Number.isInteger(id)) {
      if (seen.has(id)) {
        internalFailures.push(`duplicate row id ${id}`)
      }
      seen.add(id)
    }
  }
  const expected = new Set(Array.from({ length: rows.length }, (_, index) => index + 1))
  const idsMatchExpected = seen.size === expected.size && [...expected].every((id) => seen.has(id))
  if (!idsMatchExpected) {
    internalFailures.push(`row ids are not exactly the contiguous set 1..${rows.length}`)
  }

  const counts = { total: rows.length, byState: {}, requiredPass: 0 }
  for (const row of rows) {
    const state = isRecord(row) && typeof row.state === 'string' ? row.state : 'INVALID'
    counts.byState[state] = (counts.byState[state] ?? 0) + 1
    if (state === 'PASS') {
      counts.requiredPass += 1
    }
  }

  if (internalFailures.length > 0) {
    return { failures, internalFailures, counts }
  }

  for (const row of rows) {
    if (row.required && row.state !== 'PASS') {
      failures.push({
        kind: 'not-pass',
        id: row.id,
        row: row.row,
        detail: `state=${row.state}, reason=${row.reason ?? '(none)'}`
      })
    }
    if (row.state === 'PASS' && row.stateSource === 'stage-zero-seed') {
      failures.push({
        kind: 'unmeasured-pass',
        id: row.id,
        row: row.row,
        detail: 'PASS carries stateSource "stage-zero-seed", not re-measured against this worktree'
      })
    }

    const resolvedEntries = row.evidence.map((entry) => ({
      entry,
      ...resolveEvidence(entry, { exists, gateScripts })
    }))
    for (const { entry, resolved, detail } of resolvedEntries) {
      if ((entry.kind === 'file' || entry.kind === 'gate') && !resolved) {
        failures.push({ kind: 'unresolved-evidence', id: row.id, row: row.row, detail })
      }
    }
    if (row.state === 'PASS' && !resolvedEntries.some((result) => result.resolved)) {
      failures.push({
        kind: 'no-resolvable-evidence',
        id: row.id,
        row: row.row,
        detail: 'no file/gate evidence entry resolves'
      })
    }
  }

  return { failures, internalFailures, counts }
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

/**
 * `minimumRows` exists so a synthetic fixture can hold a handful of rows without tripping the
 * floor. Production callers pass nothing; a test pins MINIMUM_ROWS itself so this seam cannot
 * quietly become the way the floor is lowered.
 */
export async function main(root = process.cwd(), { minimumRows = MINIMUM_ROWS } = {}) {
  let manifest
  try {
    manifest = JSON.parse(await fs.readFile(path.join(root, PACKAGE_PATH), 'utf8'))
  } catch (error) {
    console.error(`${PACKAGE_PATH}: unable to read or parse (${error.message})`)
    console.error(`Verdict: ${VERDICT_UNREADABLE_INPUT}`)
    return 3
  }
  const scripts = isRecord(manifest.scripts) ? manifest.scripts : {}
  const gateScripts = Object.keys(scripts)

  let rawMatrix
  try {
    rawMatrix = await fs.readFile(path.join(root, MATRIX_PATH), 'utf8')
  } catch (error) {
    console.error(`${MATRIX_PATH}: unable to read (${error.message})`)
    console.error(`Verdict: ${VERDICT_UNREADABLE_INPUT}`)
    return 3
  }

  const parseErrors = []
  const matrix = parse(rawMatrix, parseErrors, { allowTrailingComma: true })
  // Why exit 3: this gate is red by design, so its steady state is exit 1 (CONTRACT INVALID).
  // Unreadable input needs its own code so a malformed matrix can never blend into that expected
  // red — sibling gates use 1 for unreadable input because THEIR steady state is 0.
  if (parseErrors.length > 0) {
    const first = parseErrors[0]
    console.error(
      `${MATRIX_PATH}: parse error ${printParseErrorCode(first.error)} at offset ${first.offset}`
    )
    console.error(`Verdict: ${VERDICT_UNREADABLE_INPUT}`)
    return 3
  }

  const exists = (relativePath) => existsSync(path.join(root, relativePath))

  const { failures, internalFailures, counts } = evaluateMatrix({
    matrix,
    exists,
    gateScripts,
    minimumRows
  })

  const { verdict, code } = resolveVerdict({ failures, internalFailures })

  for (const failure of failures) {
    console.error(`- row ${failure.id} (${failure.row}): ${failure.kind}: ${failure.detail}`)
  }
  for (const failure of internalFailures) {
    console.error(`! ${failure}`)
  }

  const stateSummary = Object.entries(counts.byState)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([state, count]) => `${state}=${count}`)
    .join(' ')
  console.log(
    `dws completeness: ${counts.requiredPass} of ${counts.total} required row(s) PASS (${stateSummary})`
  )

  if (code !== 0) {
    console.error(`Verdict: ${verdict}`)
  }
  return code
}

if (isEntryPoint(process.argv[1], import.meta.filename)) {
  process.exit(await main())
}
