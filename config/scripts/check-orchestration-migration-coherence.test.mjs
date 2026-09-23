import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  checkMigrationCoherence,
  MINIMUM_LADDER_COLUMNS,
  parseLadderColumns,
  parseRegistry,
  readBaseline
} from './check-orchestration-migration-coherence.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (rel) => readFileSync(join(REPO, rel), 'utf8')

// Synthetic subjects: a drill pinned to a real defect decays the moment it is fixed.
const ladderSource = (steps) =>
  ['class OrchestrationDb {', '  private migrate(): void {', ...steps, '    this.db.pragma(`user_version = ${SCHEMA_VERSION}`)', '  }', '}'].join('\n')
const step = (version, table, column) =>
  `    if (current < ${version}) { this.db.exec('ALTER TABLE ${table} ADD COLUMN ${column} TEXT') }`
const registrySource = ({ unversioned = [], versioned = [] }) =>
  [
    'const POST_V6_COLUMNS = [',
    ...unversioned.map(([t, c]) => `  ['${t}', '${c}'],`),
    '] as const',
    '',
    'const VERSIONED_POST_V6_COLUMNS = [',
    ...versioned.map(([v, t, c]) => `  { version: ${v}, table: '${t}', column: '${c}' },`),
    '] as const'
  ].join('\n')

const check = ({ steps, unversioned, versioned, frozen = [], minimumColumns = 1 }) =>
  checkMigrationCoherence({
    ladder: parseLadderColumns(ladderSource(steps)),
    registry: parseRegistry(registrySource({ unversioned, versioned })),
    frozenUnversioned: frozen,
    minimumColumns
  }).failures
const kinds = (failures) => failures.map((f) => f.kind)

describe('a new post-v6 ladder column', () => {
  it('passes when registered with the version that introduces it', () => {
    expect(check({ steps: [step(24, 'tasks', 'owner')], versioned: [[24, 'tasks', 'owner']] })).toEqual([])
  })

  it('is refused when registered nowhere, because a skewed database missing it is never repaired', () => {
    const failures = check({ steps: [step(24, 'tasks', 'owner')] })

    expect(kinds(failures)).toEqual(['FORGOTTEN'])
    expect(failures[0].detail).toMatch(/v24 ladder step/)
  })

  it('is refused in the unversioned list, because older databases would replay from v6', () => {
    const failures = check({ steps: [step(24, 'tasks', 'owner')], unversioned: [['tasks', 'owner']] })

    expect(kinds(failures)).toEqual(['NEW_UNVERSIONED'])
    expect(failures[0].detail).toMatch(/replay from v6/)
    expect(failures[0].detail).toMatch(/version: 24, table: 'tasks', column: 'owner'/)
  })

  it('is refused when registered at a different version than the step that adds it', () => {
    expect(kinds(check({ steps: [step(24, 't', 'c')], versioned: [[23, 't', 'c']] }))).toEqual(['VERSION_MISMATCH'])
  })

  it('is refused when registered in both lists', () => {
    const failures = check({ steps: [step(24, 't', 'c')], unversioned: [['t', 'c']], versioned: [[24, 't', 'c']], frozen: ['t.c'] })

    expect(kinds(failures)).toEqual(['DOUBLE_REGISTERED'])
  })
})

describe('the frozen legacy list', () => {
  it('admits an old unversioned column it has frozen', () => {
    expect(check({ steps: [step(10, 't', 'c')], unversioned: [['t', 'c']], frozen: ['t.c'] })).toEqual([])
  })

  it('refuses an entry whose column has left the unversioned list', () => {
    expect(kinds(check({ steps: [step(10, 't', 'c')], versioned: [[10, 't', 'c']], frozen: ['t.c'] }))).toEqual([
      'STALE_BASELINE'
    ])
  })
})

describe('the gate cannot go blind quietly', () => {
  it('refuses a versioned registration that no ladder step adds', () => {
    expect(kinds(check({ steps: [], versioned: [[24, 't', 'gone']] }))).toContain('STALE_REGISTRATION')
  })

  it('refuses when the scan finds fewer columns than the ladder is known to hold', () => {
    const failures = check({ steps: [step(24, 't', 'c')], versioned: [[24, 't', 'c']], minimumColumns: 10 })

    expect(kinds(failures)).toEqual(['PARSER_BLIND'])
  })

  it('refuses when it cannot locate the migrate() body at all', () => {
    const failures = checkMigrationCoherence({
      ladder: parseLadderColumns('class Nothing {}'),
      registry: parseRegistry(registrySource({})),
      frozenUnversioned: []
    }).failures

    expect(kinds(failures)).toEqual(['PARSER_BLIND'])
  })

  it('refuses a second ALTER whose table name is built at runtime', () => {
    const templated = "    if (current < 9) { for (const table of T) this.db.exec(`ALTER TABLE ${table} ADD COLUMN x TEXT`) }"
    const failures = check({ steps: [templated, templated.replace('9', '11')] })

    expect(kinds(failures)).toContain('TEMPLATED_ALTER')
  })

  it('refuses an ALTER outside any version guard', () => {
    const unguarded = "    this.db.exec('ALTER TABLE t ADD COLUMN c TEXT')"

    expect(kinds(check({ steps: [unguarded] }))).toEqual(['UNGUARDED_COLUMN'])
  })

  it('does not judge pre-v6 columns, which predate the probe entirely', () => {
    expect(check({ steps: [step(3, 'messages', 'delivered_at')] })).toEqual([])
  })
})

describe('the real orchestration ladder', () => {
  const ladder = parseLadderColumns(read('src/main/runtime/orchestration/db.ts'))
  const registrySource = read('src/main/runtime/orchestration/orchestration-schema-version-skew.ts')
  const frozen = readBaseline(read('config/orchestration-unversioned-column-baseline.txt'))

  it('is coherent with its registry', () => {
    const { failures } = checkMigrationCoherence({ ladder, registry: parseRegistry(registrySource), frozenUnversioned: frozen })

    expect(failures).toEqual([])
    expect(ladder.columns.length).toBeGreaterThanOrEqual(MINIMUM_LADDER_COLUMNS)
  })

  // The defect as it stood on 2026-09-22: three v24 columns added to the ladder and
  // registered nowhere. Removing their registration must reproduce exactly that.
  it('reports the three v24 columns as forgotten without their registration', () => {
    const withoutV24 = registrySource
      .split('\n')
      .filter((line) => !/version: 24, table: 'tasks'/.test(line))
      .join('\n')
    const { failures } = checkMigrationCoherence({ ladder, registry: parseRegistry(withoutV24), frozenUnversioned: frozen })

    expect(failures.map((f) => f.detail.split(' ')[0]).sort()).toEqual([
      'tasks.created_by_pane_key',
      'tasks.created_by_process_incarnation',
      'tasks.created_by_run_generation'
    ])
    expect(kinds(failures)).toEqual(['FORGOTTEN', 'FORGOTTEN', 'FORGOTTEN'])
  })

  // In-process tests import the functions, so they stayed green while the CLI's entry guard
  // never fired on Windows and the gate exited 0 having run nothing. Only a subprocess sees that.
  it('actually runs when invoked as a script', async () => {
    const { spawnSync } = await import('node:child_process')
    const script = join(REPO, 'config/scripts/check-orchestration-migration-coherence.mjs')

    const result = spawnSync(process.execPath, [script], { encoding: 'utf8', cwd: REPO })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('orchestration migration coherence: ok')
  })
})
