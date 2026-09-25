import { describe, expect, it } from 'vitest'

import { presentConnectedApplicationStatus } from './connected-application-presentation'

describe('connected application status presentation', () => {
  it('gives the positive tone only to an accepted session, never to mere reachability', () => {
    const tones = Object.fromEntries(
      (
        [
          { state: 'connected', build: 'b' },
          { state: 'auth-required', build: 'b' },
          { state: 'degraded', detail: 'x' },
          { state: 'unreachable', detail: 'x' },
          { state: 'unknown', detail: 'x' }
        ] as const
      ).map((observed) => [
        observed.state,
        presentConnectedApplicationStatus({ status: 'observed', observed }).tone
      ])
    )
    expect(tones).toEqual({
      connected: 'ready',
      'auth-required': 'caution',
      degraded: 'caution',
      unreachable: 'refused',
      unknown: 'neutral'
    })
  })

  it('keeps "still checking" and "could not check" apart from every observed state', () => {
    expect(presentConnectedApplicationStatus(undefined).state).toBe('checking')
    expect(
      presentConnectedApplicationStatus({ status: 'failed', reason: 'IPC gone' })
    ).toMatchObject({ state: 'check-failed', detail: 'IPC gone' })
  })
})
