import { describe, expect, it } from 'vitest'

import { canonicalBacklogEventJson, describeBacklogEventLogDefect } from './backlog-event-log'
import type { BacklogItemEvent } from './backlog-types'

function event(n: number, data: BacklogItemEvent['data'] = {}): BacklogItemEvent {
  return {
    id: `ble_00000000-0000-4000-8000-00000000000${n}`,
    type: n === 0 ? 'created' : 'updated',
    at: n,
    data
  }
}

const stored = [event(0, { origin: 'manual' }), event(1, { fields: ['priority'] })]

describe('describeBacklogEventLogDefect', () => {
  it('accepts exactly one appended event', () => {
    expect(describeBacklogEventLogDefect(stored, [...stored, event(2)])).toBeNull()
  })

  it('accepts a stored prefix whose keys are serialized in a different order', () => {
    const reKeyed = stored.map((entry) => ({
      data: entry.data,
      at: entry.at,
      type: entry.type,
      id: entry.id
    }))
    expect(describeBacklogEventLogDefect(stored, [...reKeyed, event(2)])).toBeNull()
  })

  it('refuses a dropped event', () => {
    expect(describeBacklogEventLogDefect(stored, [stored[0], event(2)])).toBe(
      'event-log-not-extended'
    )
  })

  it('refuses reordered events', () => {
    expect(describeBacklogEventLogDefect(stored, [stored[1], stored[0], event(2)])).toBe(
      'event-log-not-extended'
    )
  })

  it('refuses an edited body under an unchanged id', () => {
    const edited = { ...stored[1], data: { fields: ['kind'] } }
    expect(describeBacklogEventLogDefect(stored, [stored[0], edited, event(2)])).toBe(
      'event-log-not-extended'
    )
  })

  it('refuses a duplicate id', () => {
    const duplicate = { ...event(2), id: stored[0].id }
    expect(describeBacklogEventLogDefect(stored, [...stored, duplicate])).toBe(
      'event-log-not-extended'
    )
  })

  it('refuses zero appended events', () => {
    expect(describeBacklogEventLogDefect(stored, [...stored])).toBe('event-count')
  })

  it('refuses two appended events', () => {
    expect(describeBacklogEventLogDefect(stored, [...stored, event(2), event(3)])).toBe(
      'event-count'
    )
  })
})

describe('canonicalBacklogEventJson', () => {
  it('is stable under key order, including nested data', () => {
    const a = { id: 'x', type: 'updated', at: 1, data: { b: 1, a: ['z'] } } as BacklogItemEvent
    const b = { data: { a: ['z'], b: 1 }, at: 1, type: 'updated', id: 'x' } as BacklogItemEvent
    expect(canonicalBacklogEventJson(a)).toBe(canonicalBacklogEventJson(b))
  })
})
