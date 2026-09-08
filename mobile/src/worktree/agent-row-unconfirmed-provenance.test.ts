import { describe, expect, it } from 'vitest'

import { isFreshNonDoneAgentStatus } from '../../../src/shared/agent-status-types'
import { agentDotState } from './agent-row-display'

/**
 * The host tells clients when it does not actually know an agent is still working.
 *
 * `restoredUnconfirmed` marks a nonterminal row hydrated from disk with no live hook since, so the
 * turn it describes may have ended while nothing was listening. Its comment in runtime-types says
 * what it is for in as many words: "so clients don't render them as confirmed activity."
 *
 * Mobile received the field and dropped it -- it was not even in the Pick, so no value of it could
 * change what the user saw. An agent that may have finished hours ago rendered as working, and kept
 * rendering as working until the 30-minute clock ran out on a timestamp that was never evidence of
 * anything. That is a client inventing lifecycle truth the host had explicitly declined to assert.
 */
describe('an unconfirmed agent row is not presented as confirmed activity', () => {
  const now = 1_000_000

  it('does not report working for a row the host could not confirm', () => {
    expect(
      agentDotState(
        { state: 'working', interrupted: false, updatedAt: now, restoredUnconfirmed: true },
        now
      )
    ).toBe('idle')
  })

  it.each(['blocked', 'waiting'] as const)(
    'does not report %s for a row the host could not confirm',
    (state) => {
      expect(
        agentDotState({ state, interrupted: false, updatedAt: now, restoredUnconfirmed: true }, now)
      ).toBe('idle')
    }
  )

  it('still reports a confirmed row at the same instant, so the marker is what moved it', () => {
    // Positive control: without this, a function that returned 'idle' unconditionally would pass.
    expect(
      agentDotState(
        { state: 'working', interrupted: false, updatedAt: now, restoredUnconfirmed: false },
        now
      )
    ).toBe('working')
  })

  it('keeps interrupted ahead of provenance, because a cancelled turn really did end', () => {
    expect(
      agentDotState(
        { state: 'done', interrupted: true, updatedAt: now, restoredUnconfirmed: true },
        now
      )
    ).toBe('interrupted')
  })

  it('leaves a terminal done alone -- the marker only ever qualifies nonterminal states', () => {
    expect(
      agentDotState(
        { state: 'done', interrupted: false, updatedAt: now, restoredUnconfirmed: true },
        now
      )
    ).toBe('done')
  })

  it('agrees with the desktop freshness rule it is meant to mirror', () => {
    // The point of the capability: one rule, not two that drift. If mobile ever disagrees with
    // the shared predicate about the same row, this is the test that says so.
    for (const restoredUnconfirmed of [true, false]) {
      const row = { state: 'working' as const, interrupted: false, updatedAt: now, restoredUnconfirmed }
      expect(agentDotState(row, now) === 'working').toBe(
        isFreshNonDoneAgentStatus(row, now, 30 * 60 * 1000)
      )
    }
  })
})
