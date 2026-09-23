// Characterizes the orchestration graph as Agent Federation found it: participants are terminal
// handles, a parent chain has no depth bound, and a decision gate resolves against no subject.
// Each case is inverted IN PLACE by the change that closes it, so the diff is the evidence.
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'

describe('delegation authority, as found', () => {
  const databases: OrchestrationDb[] = []

  afterEach(() => {
    for (const database of databases) {
      database.close()
    }
    databases.length = 0
  })

  function createDb(): OrchestrationDb {
    const database = new OrchestrationDb(':memory:')
    databases.push(database)
    return database
  }

  it('records who created a task only as a terminal incarnation, never as a durable agent', () => {
    const db = createDb()

    const task = db.createTask({ spec: 'investigate', createdByTerminalHandle: 'term_abc' })

    expect(task.created_by_terminal_handle).toBe('term_abc')
    expect(Object.keys(task).filter((key) => key.includes('agent'))).toEqual([])
  })

  it('accepts a parent chain of any depth', () => {
    const db = createDb()
    let parentId: string | undefined
    for (let depth = 0; depth < 24; depth += 1) {
      parentId = db.createTask({ spec: `level ${depth}`, parentId }).id
    }

    expect(db.getTask(parentId!)?.parent_id).not.toBeNull()
  })

  it('resolves a decision gate with free text bound to no revision', () => {
    const db = createDb()
    const task = db.createTask({ spec: 'change the migration' })
    const gate = db.createGate({ taskId: task.id, question: 'Ship this patch?' })

    const resolved = db.resolveGate(gate.id, 'approved')

    expect(resolved?.status).toBe('resolved')
    expect(Object.keys(resolved!).filter((key) => /subject|revision|commit/.test(key))).toEqual([])
    expect(db.getTask(task.id)?.status).toBe('ready')
  })
})
