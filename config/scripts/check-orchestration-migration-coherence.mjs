#!/usr/bin/env node
// Keeps the orchestration migration ladder and its skew registry from diverging.
//
// db.ts carries `if (current < N) { ALTER TABLE t ADD COLUMN c }`. Separately,
// orchestration-schema-version-skew.ts lists the post-v6 columns that
// `hasCompletePostV6Schema` probes, and when that probe fails,
// `resolveOrchestrationMigrationStartVersion` returns Math.min(stored, schema, 6).
//
// Two ways to get the second place wrong, both silent at review time:
//
//   FORGOTTEN  a ladder column registered nowhere is never probed, so a
//              version-skewed database missing it starts at its stored version,
//              the ALTER never runs, and the column is absent at runtime.
//   UNVERSIONED a NEW ladder column added to the unversioned list is required of
//              every database, including ones whose stored version legitimately
//              predates it -- so each of them replays migrations from v6.
//
// The rule: a new post-v6 ladder column is registered in VERSIONED_POST_V6_COLUMNS
// with the version that introduces it. The unversioned list is frozen legacy and
// may only shrink.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Why: `file://${argv[1]}` never equals import.meta.url on Windows, so the gate exited 0
// having run nothing. The estate's tested helper compares real paths instead.
import { isEntryPoint } from './check-mobile-capability-aperture.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const LADDER_FILE = 'src/main/runtime/orchestration/db.ts'
const REGISTRY_FILE = 'src/main/runtime/orchestration/orchestration-schema-version-skew.ts'
const BASELINE_FILE = 'config/orchestration-unversioned-column-baseline.txt'

// A parser that silently stopped matching reports what a healthy ladder reports.
export const MINIMUM_LADDER_COLUMNS = 10

// One ladder step builds its table name at runtime (the run_id loop over a fixed
// table list). Its columns are real and invisible to a literal scan, so the count
// is pinned: a NEW templated ALTER is a hole in this gate's aperture and must be
// declared rather than silently unread.
export const KNOWN_TEMPLATED_ALTER_SITES = 1

export function parseLadderColumns(source) {
  const start = source.indexOf('private migrate(): void {')
  const end = source.indexOf('user_version = ${SCHEMA_VERSION}')
  if (start < 0 || end < 0 || end <= start) {
    return { error: 'could not locate the migrate() body; the ladder parser is blind' }
  }
  const body = source.slice(start, end)

  const events = []
  for (const m of body.matchAll(/current\s*<\s*(\d+)/g)) {
    events.push({ at: m.index, kind: 'guard', version: Number(m[1]) })
  }
  for (const m of body.matchAll(/ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)/gi)) {
    events.push({ at: m.index, kind: 'column', table: m[1], column: m[2] })
  }
  for (const m of body.matchAll(/ALTER TABLE\s+\$\{/g)) {
    events.push({ at: m.index, kind: 'templated' })
  }
  events.sort((a, b) => a.at - b.at)

  const columns = []
  const templated = []
  let guard = null
  for (const event of events) {
    if (event.kind === 'guard') guard = event.version
    else if (event.kind === 'templated') templated.push({ version: guard })
    else columns.push({ table: event.table, column: event.column, version: guard })
  }
  return { columns, templated }
}

export function parseRegistry(source) {
  const listBetween = (name) => {
    const start = source.indexOf(`const ${name} = [`)
    if (start < 0) return null
    const end = source.indexOf('] as const', start)
    return end < 0 ? null : source.slice(start, end)
  }
  const unversionedBlock = listBetween('POST_V6_COLUMNS')
  const versionedBlock = listBetween('VERSIONED_POST_V6_COLUMNS')
  if (unversionedBlock === null || versionedBlock === null) {
    return { error: 'could not locate both registries; the registry parser is blind' }
  }
  const unversioned = [...unversionedBlock.matchAll(/\[\s*'([^']+)'\s*,\s*'([^']+)'\s*\]/g)].map((m) => ({
    table: m[1],
    column: m[2]
  }))
  const versioned = [
    ...versionedBlock.matchAll(/version:\s*(\d+),\s*table:\s*'([^']+)',\s*column:\s*'([^']+)'/g)
  ].map((m) => ({ version: Number(m[1]), table: m[2], column: m[3] }))
  return { unversioned, versioned }
}

const key = ({ table, column }) => `${table}.${column}`

export function checkMigrationCoherence({ ladder, registry, frozenUnversioned, minimumColumns = MINIMUM_LADDER_COLUMNS }) {
  const failures = []
  if (ladder.error) return { failures: [{ kind: 'PARSER_BLIND', detail: ladder.error }] }
  if (registry.error) return { failures: [{ kind: 'PARSER_BLIND', detail: registry.error }] }

  if (ladder.columns.length < minimumColumns) {
    failures.push({
      kind: 'PARSER_BLIND',
      detail: `found ${ladder.columns.length} ladder columns, expected at least ${minimumColumns}; the scan may have stopped seeing ALTER statements`
    })
  }
  if (ladder.templated.length > KNOWN_TEMPLATED_ALTER_SITES) {
    const versions = ladder.templated.map((site) => `v${site.version}`).join(', ')
    failures.push({
      kind: 'TEMPLATED_ALTER',
      detail: `${ladder.templated.length} templated ALTER sites (${versions}), expected ${KNOWN_TEMPLATED_ALTER_SITES}; a table name built at runtime is invisible to this gate and must be declared`
    })
  }

  const unversioned = new Set(registry.unversioned.map(key))
  const versioned = new Map(registry.versioned.map((entry) => [key(entry), entry.version]))
  const frozen = new Set(frozenUnversioned)

  for (const entry of ladder.columns) {
    if (entry.version === null || entry.version === undefined) {
      failures.push({ kind: 'UNGUARDED_COLUMN', detail: `${key(entry)} is added outside any 'current < N' guard` })
      continue
    }
    if (entry.version <= 6) continue
    const id = key(entry)
    const inUnversioned = unversioned.has(id)
    const registeredVersion = versioned.get(id)

    if (!inUnversioned && registeredVersion === undefined) {
      failures.push({
        kind: 'FORGOTTEN',
        detail: `${id} is added by the v${entry.version} ladder step but registered in neither list; a skewed database missing it will never be repaired`
      })
      continue
    }
    if (inUnversioned && registeredVersion !== undefined) {
      failures.push({ kind: 'DOUBLE_REGISTERED', detail: `${id} appears in both registries` })
      continue
    }
    if (inUnversioned && !frozen.has(id)) {
      failures.push({
        kind: 'NEW_UNVERSIONED',
        detail: `${id} (v${entry.version}) was added to the unversioned list; every database older than v${entry.version} would replay from v6. Register it as { version: ${entry.version}, table: '${entry.table}', column: '${entry.column}' }`
      })
      continue
    }
    if (registeredVersion !== undefined && registeredVersion !== entry.version) {
      failures.push({
        kind: 'VERSION_MISMATCH',
        detail: `${id} is introduced at v${entry.version} but registered at v${registeredVersion}`
      })
    }
  }

  // An exemption list that outlives its subjects reads exactly like a covered one.
  const ladderIds = new Set(ladder.columns.map(key))
  for (const id of frozen) {
    if (!unversioned.has(id)) {
      failures.push({ kind: 'STALE_BASELINE', detail: `${id} is frozen as legacy but is no longer in the unversioned list; prune it` })
    }
  }
  for (const entry of registry.versioned) {
    if (!ladderIds.has(key(entry))) {
      failures.push({
        kind: 'STALE_REGISTRATION',
        detail: `${key(entry)} is registered at v${entry.version} but no ladder step adds it`
      })
    }
  }
  return { failures }
}

export function readBaseline(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
}

if (isEntryPoint(process.argv[1], import.meta.filename)) {
  const read = (rel) => readFileSync(join(REPO, rel), 'utf8')
  const { failures } = checkMigrationCoherence({
    ladder: parseLadderColumns(read(LADDER_FILE)),
    registry: parseRegistry(read(REGISTRY_FILE)),
    frozenUnversioned: readBaseline(read(BASELINE_FILE))
  })
  if (!failures.length) {
    console.log('orchestration migration coherence: ok')
    process.exit(0)
  }
  console.error(`orchestration migration coherence: ${failures.length} problem(s)\n`)
  for (const f of failures) console.error(`  [${f.kind}] ${f.detail}`)
  process.exit(1)
}
