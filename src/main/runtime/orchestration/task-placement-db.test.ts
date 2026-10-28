import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb, SCHEMA_VERSION } from './db'

describe('task host placements', () => {
  let db: OrchestrationDb
  afterEach(() => db?.close())

  it('records where each task of a run was placed and replaces on re-place', () => {
    db = new OrchestrationDb(':memory:')
    const a = db.createTask({ spec: 'job a' })
    const b = db.createTask({ spec: 'job b' })
    db.recordTaskPlacement({ taskId: a.id, hostKey: 'fingerprint:fp-win', fingerprint: 'fp-win', address: 'local', label: 'laptop' })
    db.recordTaskPlacement({ taskId: b.id, hostKey: 'fingerprint:fp-gex', fingerprint: 'fp-gex', address: 'gex44', label: 'gex44' })
    const rows = db.listRunTaskPlacements(a.run_id)
    expect(rows.map((r) => [r.task_id, r.fingerprint]).sort()).toEqual(
      [[a.id, 'fp-win'], [b.id, 'fp-gex']].sort()
    )
    db.recordTaskPlacement({ taskId: a.id, hostKey: 'fingerprint:fp-gex', fingerprint: 'fp-gex', address: 'gex44', label: 'gex44' })
    expect(db.listRunTaskPlacements(a.run_id).find((r) => r.task_id === a.id)?.fingerprint).toBe('fp-gex')
  })

  it('refuses to place a task that does not exist', () => {
    db = new OrchestrationDb(':memory:')
    expect(() =>
      db.recordTaskPlacement({ taskId: 'nope', hostKey: 'k', fingerprint: 'f', address: 'a', label: 'l' })
    ).toThrow(/unknown task/)
  })

  it('ships schema v34', () => {
    db = new OrchestrationDb(':memory:')
    expect(SCHEMA_VERSION).toBe(34)
  })
})
