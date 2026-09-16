import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessPresenceProbe } from '../../../shared/process-stats-types'
import type { AgentSleepResult } from './agent-hibernation-coordinator'
import type { SleepAuthorizationSubject } from './agent-sleep-authorization-plan'
import { createReclaimObserver, probeProcessPresenceViaIpc } from './agent-sleep-observed-reclaim'

const MB = 1024 * 1024

function subject(id: string, pid: number | null, bytes = 100 * MB): SleepAuthorizationSubject {
  return {
    paneKey: `${id}:leaf`,
    worktreeId: 'w',
    tabId: id,
    exclusionReason: null,
    footprint:
      pid === null
        ? { known: false, reason: 'no-pid' }
        : {
            known: true,
            bytes,
            metric: 'working-set',
            processes: [{ pid, memory: bytes }]
          },
    authorization: { candidateId: `cand-${id}`, signature: `sig-${id}` }
  }
}

const measuredProbe = (presentPids: number[]): ProcessPresenceProbe => ({
  sweep: 'measured',
  sweepStartedAt: 2_000,
  metric: 'working-set',
  presentPids
})

describe('observeReclaimAfterSleep', () => {
  // A partial batch: only the pane that actually slept may contribute.
  it('asks about and counts only panes whose outcome was slept', async () => {
    const probe = vi.fn(async () => measuredProbe([]))
    const observe = createReclaimObserver(probe)
    const results: AgentSleepResult[] = [
      { candidateId: 'cand-a', outcome: 'slept' },
      { candidateId: 'cand-b', outcome: 'changed' },
      { candidateId: 'cand-c', outcome: 'failed' },
      { candidateId: 'cand-d', outcome: 'not-eligible' }
    ]

    const observed = await observe({
      subjects: [subject('a', 11), subject('b', 12), subject('c', 13), subject('d', 14)],
      results,
      effectEndedAt: 1_000
    })

    expect(probe).toHaveBeenCalledWith([11])
    expect(observed).toMatchObject({ status: 'measured', bytes: 100 * MB, measuredPaneCount: 1 })
  })

  it('runs no sweep when nothing slept', async () => {
    const probe = vi.fn(async () => measuredProbe([]))
    const observed = await createReclaimObserver(probe)({
      subjects: [subject('a', 11)],
      results: [{ candidateId: 'cand-a', outcome: 'changed' }],
      effectEndedAt: 1_000
    })
    expect(probe).not.toHaveBeenCalled()
    expect(observed).toEqual({ status: 'unmeasured', reason: 'nothing-slept', sleptPaneCount: 0 })
  })

  it('runs no sweep and claims no bytes when the slept pane was never measured', async () => {
    const probe = vi.fn(async () => measuredProbe([]))
    const observed = await createReclaimObserver(probe)({
      subjects: [subject('a', null)],
      results: [{ candidateId: 'cand-a', outcome: 'slept' }],
      effectEndedAt: 1_000
    })
    expect(probe).not.toHaveBeenCalled()
    expect(observed).toEqual({ status: 'unmeasured', reason: 'no-baseline', sleptPaneCount: 1 })
  })

  it('keeps the slept outcome and reports unavailable when the probe gives nothing', async () => {
    const observed = await createReclaimObserver(async () => null)({
      subjects: [subject('a', 11)],
      results: [{ candidateId: 'cand-a', outcome: 'slept' }],
      effectEndedAt: 1_000
    })
    expect(observed).toEqual({
      status: 'unmeasured',
      reason: 'sweep-unavailable',
      sleptPaneCount: 1
    })
  })
})

describe('probeProcessPresenceViaIpc', () => {
  const withProbe = (probeProcessPresence: unknown): void => {
    vi.stubGlobal('window', { api: { memory: { probeProcessPresence } } })
  }

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('reads a rejected probe as unavailable, not as a result', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    withProbe(() => Promise.reject(new Error('no host')))
    await expect(probeProcessPresenceViaIpc([1])).resolves.toBeNull()
  })

  it('reads a missing probe as unavailable', async () => {
    withProbe(undefined)
    await expect(probeProcessPresenceViaIpc([1])).resolves.toBeNull()
  })

  it('gives up on a probe that never answers', async () => {
    vi.useFakeTimers()
    withProbe(() => new Promise(() => {}))
    const pending = probeProcessPresenceViaIpc([1])
    await vi.advanceTimersByTimeAsync(20_000)
    await expect(pending).resolves.toBeNull()
  })

  it('passes a real answer through untouched', async () => {
    const answer = measuredProbe([1])
    withProbe(() => Promise.resolve(answer))
    await expect(probeProcessPresenceViaIpc([1])).resolves.toBe(answer)
  })
})
