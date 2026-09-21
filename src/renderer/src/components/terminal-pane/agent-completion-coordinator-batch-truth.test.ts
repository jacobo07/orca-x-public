/*
 * The shared backstop call carries many panes; each pane must still act only on its own
 * answer, and only for the runtime that asked.
 */
import { describe, expect, it, vi } from 'vitest'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import {
  createDeferred,
  flushAsyncTicks,
  HOOK_DONE_QUIET_MS,
  processResult,
  useAgentCompletionCoordinatorLifecycle
} from './agent-completion-coordinator-test-harness'
import { getAgentProcessBackstop } from './agent-process-backstop'
import type { BackstopInspectProcesses } from './agent-process-backstop'
import type { RuntimeTerminalProcessInspectionOutcome } from '@/runtime/runtime-terminal-inspection-batch'

type Answer = RuntimeTerminalProcessInspectionOutcome

function pane(index: number, inspectProcesses: BackstopInspectProcesses) {
  const dispatchCompletion = vi.fn()
  const coordinator = createAgentCompletionCoordinator({
    paneKey: `tab-${index}:leaf-1`,
    getPtyId: () => `pty-${index}`,
    getSettings: () => null,
    inspectProcess: vi.fn(async () => {
      throw new Error('the per-pane call must not be used')
    }),
    inspectProcesses,
    dispatchCompletion,
    isLive: () => true,
    shouldPollProcessCadence: () => true
  })
  coordinator.startProcessTracking()
  coordinator.observeTitle('Codex working')
  return { coordinator, dispatchCompletion }
}

const agent: Answer = { status: 'inspected', inspection: processResult('codex') }
const shell: Answer = { status: 'inspected', inspection: processResult(null) }

describe('agent completion over the shared backstop call', () => {
  useAgentCompletionCoordinatorLifecycle()

  it('completes only the pane whose agent exited, and never one it could not inspect', async () => {
    const answers = new Map<string, Answer>([
      ['pty-0', agent],
      ['pty-1', agent],
      ['pty-2', agent]
    ])
    const inspectProcesses = vi.fn<BackstopInspectProcesses>(
      async (_settings, ids) => new Map(ids.map((id) => [id, answers.get(id)!]))
    )
    const panes = [0, 1, 2].map((i) => pane(i, inspectProcesses))
    await vi.advanceTimersByTimeAsync(5_000)

    answers.set('pty-0', shell)
    answers.set('pty-1', { status: 'failed' })
    await vi.advanceTimersByTimeAsync(30_000)

    expect(panes[0]!.dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(panes[0]!.dispatchCompletion).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({ source: 'process-exit' })
    )
    expect(panes[1]!.dispatchCompletion).not.toHaveBeenCalled()
    expect(panes[2]!.dispatchCompletion).not.toHaveBeenCalled()
    // Several panes, one call per tick.
    const idsPerCall = inspectProcesses.mock.calls.map(([, ids]) => ids.length)
    expect(Math.max(...idsPerCall)).toBe(3)
  })

  it('drops an answer that was asked for the runtime before a restart', async () => {
    let answer: Answer = agent
    const held = createDeferred<Map<string, Answer>>()
    let holdNext = false
    const inspectProcesses = vi.fn<BackstopInspectProcesses>(async (_settings, ids) => {
      if (holdNext) {
        holdNext = false
        return held.promise
      }
      return new Map(ids.map((id) => [id, answer]))
    })
    const { coordinator, dispatchCompletion } = pane(0, inspectProcesses)
    await vi.advanceTimersByTimeAsync(5_000)

    holdNext = true
    await vi.advanceTimersByTimeAsync(1_000)
    expect(getAgentProcessBackstop().snapshot().inFlightGroups).toBe(1)
    // The pane's runtime is replaced while its question is in flight; the new one runs no agent.
    coordinator.resetCompletionState()
    answer = shell
    // The old runtime's answer still says the agent is alive.
    held.resolve(new Map([['pty-0', agent]]))
    await flushAsyncTicks(10)
    await vi.advanceTimersByTimeAsync(10_000)

    // Applied to the new runtime, it would lend it agent evidence and two idle samples would
    // then announce an exit for an agent that never ran there.
    expect(dispatchCompletion).not.toHaveBeenCalled()
    expect(inspectProcesses.mock.calls.length).toBeGreaterThan(3)
  })

  it('ignores an answer that arrives after its pane closed, and leaves nothing behind', async () => {
    const held = createDeferred<Map<string, Answer>>()
    let holdNext = false
    const inspectProcesses = vi.fn<BackstopInspectProcesses>(async (_settings, ids) => {
      if (holdNext) {
        return held.promise
      }
      return new Map(ids.map((id) => [id, agent]))
    })
    const { coordinator, dispatchCompletion } = pane(0, inspectProcesses)
    await vi.advanceTimersByTimeAsync(5_000)
    holdNext = true
    await vi.advanceTimersByTimeAsync(1_000)

    coordinator.dispose()
    held.resolve(new Map([['pty-0', shell]]))
    await flushAsyncTicks(10)
    held.resolve(new Map([['pty-0', shell]]))
    await vi.advanceTimersByTimeAsync(10_000)

    expect(dispatchCompletion).not.toHaveBeenCalled()
    expect(getAgentProcessBackstop().snapshot()).toMatchObject({ scheduled: 0, timerArmed: false })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('completes on a hook after its own quiet window, even with the backstop stuck', async () => {
    const inspectProcesses = vi.fn<BackstopInspectProcesses>(() => new Promise(() => {}))
    const { coordinator, dispatchCompletion } = pane(0, inspectProcesses)
    await vi.advanceTimersByTimeAsync(2_500)
    expect(getAgentProcessBackstop().snapshot().inFlightGroups).toBe(1)

    coordinator.observeHookStatus({ state: 'done', agentType: 'codex', prompt: '' } as never)
    await vi.advanceTimersByTimeAsync(HOOK_DONE_QUIET_MS)

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(dispatchCompletion).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({ source: 'hook' })
    )
  })
})
