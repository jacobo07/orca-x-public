import { describe, expect, it } from 'vitest'
import { composeWakeProgress, type HostWakeStageRecord } from './host-wake'

const SENT_AT = 1_000

const BROKER: HostWakeStageRecord[] = [
  { stage: 'requested', observedAt: 990, observer: 'broker' },
  { stage: 'authorized', observedAt: 995, observer: 'broker' },
  { stage: 'packet-sent', observedAt: SENT_AT, observer: 'broker' }
]

describe('composeWakeProgress', () => {
  it('ends at packet-sent while the target has not answered', () => {
    const stages = composeWakeProgress(BROKER, null)
    expect(stages.map((s) => s.stage)).toEqual(['requested', 'authorized', 'packet-sent'])
  })

  it('appends host-announced from a live answer observed after packet-sent', () => {
    const stages = composeWakeProgress(BROKER, { observedAt: SENT_AT + 5, graphStatus: 'starting' })
    expect(stages.at(-1)).toEqual({
      stage: 'host-announced',
      observedAt: SENT_AT + 5,
      observer: 'client'
    })
    expect(stages.some((s) => s.stage === 'runtime-ready')).toBe(false)
  })

  it('appends runtime-ready only when the answer reports graphStatus ready', () => {
    const stages = composeWakeProgress(BROKER, { observedAt: SENT_AT + 5, graphStatus: 'ready' })
    expect(stages.map((s) => s.stage)).toEqual([
      'requested',
      'authorized',
      'packet-sent',
      'host-announced',
      'runtime-ready'
    ])
    expect(stages.slice(3).every((s) => s.observer === 'client')).toBe(true)
  })

  it('adds nothing for an answer observed at or before packet-sent', () => {
    for (const observedAt of [SENT_AT, SENT_AT - 1]) {
      const stages = composeWakeProgress(BROKER, { observedAt, graphStatus: 'ready' })
      expect(stages.map((s) => s.stage)).toEqual(['requested', 'authorized', 'packet-sent'])
    }
  })

  it('adds nothing when the broker never sent a packet', () => {
    const failed: HostWakeStageRecord[] = [
      ...BROKER.slice(0, 2),
      { stage: 'packet-send-failed', observedAt: SENT_AT, observer: 'broker', code: 'EACCES' }
    ]
    const stages = composeWakeProgress(failed, { observedAt: SENT_AT + 5, graphStatus: 'ready' })
    expect(stages.map((s) => s.stage)).toEqual(['requested', 'authorized', 'packet-send-failed'])
    expect(stages.at(-1)?.code).toBe('EACCES')
  })

  it('drops host-announced and runtime-ready claimed by a broker', () => {
    const lying = [
      ...BROKER,
      { stage: 'host-announced', observedAt: SENT_AT + 1, observer: 'broker' },
      { stage: 'runtime-ready', observedAt: SENT_AT + 1, observer: 'broker' }
    ]
    const stages = composeWakeProgress(lying, null)
    expect(stages.map((s) => s.stage)).toEqual(['requested', 'authorized', 'packet-sent'])
  })

  it('composes malformed input to [] or skips malformed records without throwing', () => {
    expect(composeWakeProgress(null, null)).toEqual([])
    expect(composeWakeProgress('packet-sent', null)).toEqual([])
    expect(composeWakeProgress({ stages: BROKER }, null)).toEqual([])
    const mixed = composeWakeProgress(
      [null, 7, { stage: 'packet-sent' }, { stage: 'bogus', observedAt: 1 }, BROKER[0]],
      { observedAt: SENT_AT + 5 }
    )
    expect(mixed).toEqual([BROKER[0]])
  })
})
