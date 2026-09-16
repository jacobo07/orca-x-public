/*
 * Cardinality of the process-exit backstop across many panes (Resource Elasticity R4).
 * Single-pane cadence is pinned in agent-completion-coordinator-process-cadence.test.ts;
 * this file pins how the total scales with pane count and what a pane costs once it
 * stops being a live, visible subject.
 */
import { describe, expect, it, vi } from 'vitest'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import {
  processResult,
  useAgentCompletionCoordinatorLifecycle
} from './agent-completion-coordinator-test-harness'
import type { AgentCompletionCoordinator } from './agent-completion-coordinator-types'

const WINDOW_MS = 60_000
// Mirrors MAX_INSPECTION_STARTS_PER_SECOND in agent-process-inspection-queue.ts.
const WINDOW_START_BUDGET = 8 * (WINDOW_MS / 1_000)

type PaneState = { visible: boolean; live: boolean; agent: boolean }

function createPanes(count: number, state: PaneState) {
  const inspectProcess = vi.fn(async () => processResult(state.agent ? 'codex' : null))
  const coordinators: AgentCompletionCoordinator[] = []
  for (let i = 0; i < count; i++) {
    const coordinator = createAgentCompletionCoordinator({
      paneKey: `tab-${i}:leaf-1`,
      getPtyId: () => `pty-${i}`,
      getSettings: () => null,
      inspectProcess,
      dispatchCompletion: vi.fn(),
      isLive: () => state.live,
      shouldPollProcessCadence: () => state.visible
    })
    coordinator.startProcessTracking()
    if (state.agent) {
      coordinator.observeTitle('Codex working')
    }
    coordinators.push(coordinator)
  }
  return { inspectProcess, coordinators }
}

function inspectedPtyIds(inspectProcess: ReturnType<typeof vi.fn>): Set<string> {
  return new Set(inspectProcess.mock.calls.map((call) => String(call[1])))
}

describe('agent completion backstop cardinality', () => {
  useAgentCompletionCoordinatorLifecycle()

  it('scales with visible agent panes until the per-window start budget caps it', async () => {
    const one = createPanes(1, { visible: true, live: true, agent: true })
    await vi.advanceTimersByTimeAsync(WINDOW_MS)
    const perPaneAtOne = one.inspectProcess.mock.calls.length
    one.coordinators.forEach((c) => c.dispose())

    const fifty = createPanes(50, { visible: true, live: true, agent: true })
    await vi.advanceTimersByTimeAsync(WINDOW_MS)
    const totalAtFifty = fifty.inspectProcess.mock.calls.length

    expect(perPaneAtOne).toBeGreaterThanOrEqual(70)
    // Why: the queue, not the pane count, bounds volume; the cost moves into latency.
    expect(totalAtFifty).toBeLessThanOrEqual(WINDOW_START_BUDGET + 50)
    expect(totalAtFifty / 50).toBeLessThan(perPaneAtOne / 5)
    // Starvation guard: a capped queue must still reach every pane.
    expect(inspectedPtyIds(fifty.inspectProcess).size).toBe(50)
  })

  it('charges nothing for hidden panes without agent evidence, at any count', async () => {
    const { inspectProcess } = createPanes(50, { visible: false, live: true, agent: false })
    await vi.advanceTimersByTimeAsync(WINDOW_MS)

    expect(inspectProcess).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('charges nothing for panes without a live runtime', async () => {
    const { inspectProcess } = createPanes(50, { visible: true, live: false, agent: true })
    await vi.advanceTimersByTimeAsync(WINDOW_MS)

    expect(inspectProcess).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops all inspection work once every pane is disposed, including queued work', async () => {
    const { inspectProcess, coordinators } = createPanes(50, {
      visible: true,
      live: true,
      agent: true
    })
    // Why: 50 panes at 750ms outrun the 8/s budget, so a backlog is queued at dispose time.
    await vi.advanceTimersByTimeAsync(5_000)
    coordinators.forEach((c) => c.dispose())
    const callsAtDispose = inspectProcess.mock.calls.length

    await vi.advanceTimersByTimeAsync(WINDOW_MS)

    expect(callsAtDispose).toBeGreaterThan(0)
    expect(inspectProcess.mock.calls.length).toBe(callsAtDispose)
    expect(vi.getTimerCount()).toBe(0)
  })
})
