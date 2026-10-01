import { describe, expect, it } from 'vitest'
import { BACKLOG_ITEM_STATES, type BacklogItemState } from '../../../../shared/backlog-types'
import { backlogStateTone, type BacklogTone } from './backlog-presentation'

const EXPECTED: Record<BacklogItemState, BacklogTone> = {
  blocked: 'critical',
  'needs-triage': 'pressured',
  review: 'pressured',
  unknown: 'unknown',
  stale: 'unknown',
  done: 'idle',
  dismissed: 'idle',
  superseded: 'idle',
  ready: 'plain',
  'waiting-for-executor': 'plain',
  preparing: 'plain',
  running: 'plain'
}

describe('backlogStateTone', () => {
  it('maps all twelve ledger states to the tone the UI-SPEC colour table names', () => {
    expect(BACKLOG_ITEM_STATES).toHaveLength(12)
    for (const state of BACKLOG_ITEM_STATES) {
      expect(backlogStateTone(state), state).toBe(EXPECTED[state])
    }
  })
})
