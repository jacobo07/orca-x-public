import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createAgentProcessBackstop,
  type AgentProcessBackstop,
  type BackstopInspectionOutcome,
  type BackstopInspectionRequest,
  type BackstopInspectProcesses
} from './agent-process-backstop'
import { createDeferred, flushAsyncTicks } from './agent-completion-coordinator-test-harness'
import type { RuntimeTerminalProcessInspectionOutcome } from '@/runtime/runtime-terminal-inspection-batch'

const live = {
  status: 'inspected',
  inspection: { foregroundProcess: 'codex', hasChildProcesses: true }
} as const

function answerAll(outcome: RuntimeTerminalProcessInspectionOutcome = live) {
  return vi.fn<BackstopInspectProcesses>(
    async (_settings, ids) => new Map(ids.map((id) => [id, outcome]))
  )
}

function request(
  ptyId: string,
  inspectProcesses: BackstopInspectProcesses | undefined,
  overrides: Partial<BackstopInspectionRequest> = {}
): BackstopInspectionRequest {
  return {
    ptyId,
    settings: null,
    inspectProcess: vi.fn(async () => live.inspection),
    ...(inspectProcesses ? { inspectProcesses } : {}),
    isActive: () => true,
    ...overrides
  }
}

describe('agent process backstop', () => {
  let backstop: AgentProcessBackstop

  beforeEach(() => {
    vi.useFakeTimers()
    backstop = createAgentProcessBackstop()
  })

  afterEach(() => {
    backstop.dispose()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('holds no timer without subjects, one for any number, and none after the last leaves', () => {
    expect(vi.getTimerCount()).toBe(0)
    const owners = Array.from({ length: 10 }, () => ({}))
    owners.forEach((owner, i) => backstop.schedule(owner, 750 + i * 10, () => {}))
    expect(vi.getTimerCount()).toBe(1)

    owners.forEach((owner) => backstop.cancel(owner))
    expect(vi.getTimerCount()).toBe(0)
    expect(backstop.snapshot()).toMatchObject({ timerArmed: false, scheduled: 0 })
  })

  it('stops once the last due subject has run and not come back', async () => {
    const onDue = vi.fn()
    backstop.schedule({}, 750, onDue)

    await vi.advanceTimersByTimeAsync(750)

    expect(onDue).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('runs subjects due within the alignment window in the same tick', async () => {
    const ran: string[] = []
    backstop.schedule({}, 750, () => ran.push('a'))
    backstop.schedule({}, 900, () => ran.push('b'))
    backstop.schedule({}, 2_000, () => ran.push('c'))

    await vi.advanceTimersByTimeAsync(750)

    expect(ran).toEqual(['a', 'b'])
    expect(backstop.snapshot().ticks).toBe(1)
  })

  it('sends every pane of a tick in one call and gives each its own answer', async () => {
    const inspectProcesses = vi.fn<BackstopInspectProcesses>(async (_settings, ids) => {
      // Why reversed: answers are keyed, so their order carries nothing.
      const entries = ids
        .toReversed()
        .map((id): [string, RuntimeTerminalProcessInspectionOutcome] => [
          id,
          id === 'p1'
            ? { status: 'failed' }
            : {
                status: 'inspected',
                inspection: { foregroundProcess: id, hasChildProcesses: true }
              }
        ])
      return new Map(entries.filter(([id]) => id !== 'p2'))
    })
    const outcomes = new Map<string, BackstopInspectionOutcome>()
    for (const id of ['p0', 'p1', 'p2']) {
      backstop.schedule({}, 750, () => {
        void backstop.inspect(request(id, inspectProcesses)).then((o) => outcomes.set(id, o))
      })
    }

    await vi.advanceTimersByTimeAsync(750)

    expect(inspectProcesses).toHaveBeenCalledExactlyOnceWith(null, ['p0', 'p1', 'p2'])
    expect(outcomes.get('p0')).toEqual({
      status: 'inspected',
      inspection: { foregroundProcess: 'p0', hasChildProcesses: true }
    })
    expect(outcomes.get('p1')).toEqual({ status: 'failed' })
    // Why: an unanswered pane is unknown, never an idle shell.
    expect(outcomes.get('p2')).toEqual({ status: 'failed' })
  })

  it('fails every pane of a call that rejects', async () => {
    const inspectProcesses = vi.fn<BackstopInspectProcesses>(async () => {
      throw new Error('ipc closed')
    })

    const outcomes = await Promise.all([
      backstop.inspect(request('a', inspectProcesses)),
      backstop.inspect(request('b', inspectProcesses))
    ])

    expect(outcomes).toEqual([{ status: 'failed' }, { status: 'failed' }])
  })

  it('never sends a pane that was disposed before its call left', async () => {
    const inspectProcesses = answerAll()
    let active = true
    const pending = backstop.inspect(request('gone', inspectProcesses, { isActive: () => active }))
    const kept = backstop.inspect(request('kept', inspectProcesses))
    active = false

    await expect(pending).resolves.toEqual({ status: 'skipped' })
    await kept
    expect(inspectProcesses).toHaveBeenCalledExactlyOnceWith(null, ['kept'])
  })

  it('never overlaps two calls for one host; panes due meanwhile ride the next', async () => {
    const first = createDeferred<Map<string, RuntimeTerminalProcessInspectionOutcome>>()
    const inspectProcesses = vi
      .fn<BackstopInspectProcesses>()
      .mockReturnValueOnce(first.promise)
      .mockImplementation(async (_settings, ids) => new Map(ids.map((id) => [id, live])))

    const slow = backstop.inspect(request('a', inspectProcesses))
    await flushAsyncTicks()
    const later = [
      backstop.inspect(request('b', inspectProcesses)),
      backstop.inspect(request('c', inspectProcesses))
    ]
    await flushAsyncTicks()

    expect(inspectProcesses).toHaveBeenCalledTimes(1)
    expect(backstop.snapshot()).toMatchObject({ pending: 2, inFlightGroups: 1 })

    first.resolve(new Map([['a', live]]))
    await expect(slow).resolves.toEqual(live)
    await expect(Promise.all(later)).resolves.toEqual([live, live])
    expect(inspectProcesses).toHaveBeenCalledTimes(2)
    expect(inspectProcesses).toHaveBeenLastCalledWith(null, ['b', 'c'])
  })

  it('does not let a slow host hold another host’s panes', async () => {
    const stuck = vi.fn<BackstopInspectProcesses>(() => new Promise(() => {}))
    const healthy = answerAll()

    void backstop.inspect(
      request('remote', stuck, { settings: { activeRuntimeEnvironmentId: 'env-1' } })
    )
    await flushAsyncTicks()
    const local = backstop.inspect(request('local', healthy))

    await expect(local).resolves.toEqual(live)
  })

  it('keeps ticking the other panes when one pane’s handler throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const after = vi.fn()
    backstop.schedule({}, 750, () => {
      throw new Error('broken pane')
    })
    backstop.schedule({}, 750, after)

    await vi.advanceTimersByTimeAsync(750)

    expect(after).toHaveBeenCalledTimes(1)
  })

  it('asks each pane on its own only when the caller has no batch inspector', async () => {
    const failing = request('b', undefined, {
      inspectProcess: vi.fn(async () => {
        throw new Error('gone')
      })
    })

    const outcomes = await Promise.all([
      backstop.inspect(request('a', undefined)),
      backstop.inspect(failing)
    ])

    expect(outcomes).toEqual([live, { status: 'failed' }])
    expect(backstop.snapshot()).toMatchObject({ singleCalls: 2, batchCalls: 0 })
  })
})
