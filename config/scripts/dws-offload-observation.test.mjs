import { describe, expect, it } from 'vitest'
import {
  applyLegOutcomes,
  failedLegsFromManifest,
  judgeLegMarker,
  legWindowFromManifest,
  observationDefects
} from './dws-offload-observation.mjs'
import { judgeAbsence, summarizeRun } from './dws-offload-measurement.mjs'

// A run that was genuinely observed end to end (same shape as dws-offload-measurement.test.mjs).
const OBSERVED = {
  observation: {
    samples: 10,
    sawStart: true,
    sawStop: true,
    spanMs: 9000,
    desktopRootPidValid: true,
    legWindowCovered: null
  },
  freeMb: { before: 5000, after: 4990, min: 4990 }
}

describe('legWindowFromManifest', () => {
  it('spans the legs that carry both stamps and ignores a TIMEOUT leg with no end', () => {
    const window = legWindowFromManifest({
      legs: [
        { leg: 'test', startUtc: '2026-09-28T00:00:10.000Z', endUtc: '2026-09-28T00:00:20.000Z' },
        { leg: 'build', startUtc: '2026-09-28T00:00:25.000Z', endUtc: '2026-09-28T00:00:40.000Z' },
        { leg: 'agent', startUtc: '2026-09-28T00:00:45.000Z', exit: 'TIMEOUT' }
      ]
    })
    expect(window).toEqual({
      startMs: Date.parse('2026-09-28T00:00:10.000Z'),
      endMs: Date.parse('2026-09-28T00:00:40.000Z')
    })
  })

  it('is null (unknown), never a fabricated window, when no leg carries both stamps', () => {
    expect(legWindowFromManifest({ legs: [{ leg: 'test', exit: 'TIMEOUT' }] })).toBeNull()
    expect(legWindowFromManifest({})).toBeNull()
  })
})

// WR-06: a crashed leg frees RAM too, so its delta must never be scored as a successful offload.
describe('leg outcomes', () => {
  it.each([
    [{ leg: 'test', exit: '1' }, 'exit=1'],
    [{ leg: 'build', exit: 'TIMEOUT' }, 'exit=TIMEOUT'],
    [{ leg: 'test' }, 'exit=missing'],
    [{ leg: 'agent', exit: '127', agentReply: 'missing' }, 'exit=127'],
    [{ leg: 'agent', exit: '0', agentReply: 'usage-limit' }, 'agentReply=usage-limit'],
    [{ leg: 'agent', exit: '0' }, 'agentReply=missing']
  ])('judgeLegMarker FAILS %j', (marker, reason) => {
    expect(judgeLegMarker(marker)).toMatchObject({ verdict: 'FAILED', reason })
  })

  it('judgeLegMarker admits exit 0, and an agent only with a matched reply', () => {
    expect(judgeLegMarker({ leg: 'test', exit: '0' }).verdict).toBe('OK')
    expect(judgeLegMarker({ leg: 'agent', exit: '0', agentReply: 'matched' }).verdict).toBe('OK')
  })

  it('a failed leg makes the offload absence INCONCLUSIVE, not PASS', () => {
    const baseline = { perFamily: { vitest: { maxCount: 1, observed: [{ pid: 1, commandLine: 'vitest.mjs' }] } } }
    const offloadFor = (legs) => ({
      ...OBSERVED,
      observation: { ...OBSERVED.observation, failedLegs: failedLegsFromManifest({ legs }) },
      perFamily: { vitest: { maxCount: 0, observed: [] } }
    })
    const failed = judgeAbsence(baseline, offloadFor([{ leg: 'test', exit: '1' }]), 'vitest')
    expect(failed.verdict).toBe('INCONCLUSIVE')
    expect(failed.reason).toContain('test exit=1')
    expect(judgeAbsence(baseline, offloadFor([{ leg: 'test', exit: '0' }]), 'vitest').verdict).toBe('PASS')
  })

  it('summarizeRun carries the failed legs into its observation', () => {
    const summary = summarizeRun([], { failedLegs: [{ leg: 'build', verdict: 'FAILED', reason: 'exit=2' }] })
    expect(observationDefects(summary).join(' ')).toContain('build exit=2')
  })

  it('applyLegOutcomes turns a remote PASS into FAIL for a failed leg and keeps a succeeded one', () => {
    const proofs = [
      { leg: 'test', verdict: 'PASS' },
      { leg: 'agent', verdict: 'PASS' }
    ]
    const result = applyLegOutcomes(proofs, [
      { leg: 'test', exit: '0' },
      { leg: 'agent', exit: '0', agentReply: 'missing' }
    ])
    expect(result[0]).toEqual({ leg: 'test', verdict: 'PASS' })
    expect(result[1]).toMatchObject({ leg: 'agent', verdict: 'FAIL' })
    expect(result[1].reason).toContain('agentReply=missing')
  })

  it('applyLegOutcomes fails a proof whose leg is absent from the manifest', () => {
    expect(applyLegOutcomes([{ leg: 'build', verdict: 'PASS' }], [])[0].verdict).toBe('FAIL')
  })
})
