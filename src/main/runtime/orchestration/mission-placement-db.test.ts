import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'

const onWin = {
  hostKey: 'fingerprint:fp-win',
  fingerprint: 'fp-win',
  address: 'local',
  label: 'laptop'
}
const onGex = {
  hostKey: 'fingerprint:fp-gex',
  fingerprint: 'fp-gex',
  address: 'runtime:env-gex',
  label: 'gex44'
}

describe('placeMissionTasks', () => {
  let db: OrchestrationDb
  afterEach(() => db?.close())

  it('records every placement of a mission', () => {
    db = new OrchestrationDb(':memory:')
    const a = db.createTask({ spec: 'job a' })
    const b = db.createTask({ spec: 'job b' })
    db.placeMissionTasks(a.run_id, [
      { taskId: a.id, ...onWin },
      { taskId: b.id, ...onGex }
    ])
    expect(db.getTaskPlacement(a.id)?.address).toBe('local')
    expect(db.getTaskPlacement(b.id)?.address).toBe('runtime:env-gex')
  })

  it('keeps the row on a retry of the same plan', () => {
    db = new OrchestrationDb(':memory:')
    const a = db.createTask({ spec: 'job a' })
    const first = db.placeMissionTasks(a.run_id, [{ taskId: a.id, ...onWin }])
    const again = db.placeMissionTasks(a.run_id, [{ taskId: a.id, ...onWin }])
    expect(again[0].placed_at).toBe(first[0].placed_at)
  })

  it('refuses a different host for a placed task and writes nothing of the batch', () => {
    db = new OrchestrationDb(':memory:')
    const a = db.createTask({ spec: 'job a' })
    const b = db.createTask({ spec: 'job b' })
    db.placeMissionTasks(a.run_id, [{ taskId: a.id, ...onWin }])
    let code: string | undefined
    try {
      db.placeMissionTasks(a.run_id, [
        { taskId: b.id, ...onWin },
        { taskId: a.id, ...onGex }
      ])
    } catch (error) {
      code = (error as { code?: string }).code
    }
    expect(code).toBe('placement_conflict')
    expect(db.getTaskPlacement(a.id)?.address).toBe('local')
    // Why: the batch is one transaction, so b's earlier row in it must have rolled back.
    expect(db.getTaskPlacement(b.id)).toBeUndefined()
  })

  it('refuses a task from another run', () => {
    db = new OrchestrationDb(':memory:')
    const a = db.createTask({ spec: 'job a' })
    let code: string | undefined
    try {
      db.placeMissionTasks('run_other', [{ taskId: a.id, ...onWin }])
    } catch (error) {
      code = (error as { code?: string }).code
    }
    expect(code).toBe('task_not_found')
    expect(db.getTaskPlacement(a.id)).toBeUndefined()
  })
})
