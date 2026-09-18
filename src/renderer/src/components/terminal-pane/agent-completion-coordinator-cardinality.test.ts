/*
 * Cardinality of the process-exit backstop across many panes (Resource Elasticity R4).
 * Single-pane cadence is pinned in agent-completion-coordinator-process-cadence.test.ts;
 * this file pins how the total scales with pane count and what a pane costs once it
 * stops being a live, visible subject.
 */
import { writeFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  measureBackstopCurve,
  type BackstopCurvePoint
} from './agent-completion-backstop-curve-harness'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import { resetAgentProcessBackstopForTests } from './agent-process-backstop'
import {
  processResult,
  useAgentCompletionCoordinatorLifecycle
} from './agent-completion-coordinator-test-harness'
import type { AgentCompletionCoordinator } from './agent-completion-coordinator-types'

const WINDOW_MS = 60_000

// Why a file: the vitest config swallows console output.
function writeCurve(curve: BackstopCurvePoint[]): void {
  if (process.env.ORCA_BACKSTOP_CURVE_OUT) {
    writeFileSync(process.env.ORCA_BACKSTOP_CURVE_OUT, JSON.stringify(curve, null, 1))
  }
}

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

  // Before the shared backstop (499c054df): timers 1/10/50, per-pane calls 54/464/464 (capped
  // at 8 starts/s), detection of a silent exit 1.25 s / 1.23 s / 9.29 s.
  it('adds no timer, no call and no detection delay per extra agent pane', async () => {
    const curve: BackstopCurvePoint[] = []
    for (const panes of [1, 10, 50]) {
      curve.push(await measureBackstopCurve(panes))
      resetAgentProcessBackstopForTests()
    }
    writeCurve(curve)
    const [one, ten, fifty] = curve as [BackstopCurvePoint, BackstopCurvePoint, BackstopCurvePoint]

    expect(curve.map((point) => point.timers)).toEqual([1, 1, 1])
    expect(curve.map((point) => point.singleCalls)).toEqual([0, 0, 0])
    // One call per tick, whatever the pane count: ticks are at most one per 70% of the 750 ms tier.
    expect(fifty.batchCalls).toBeLessThanOrEqual(ten.batchCalls)
    expect(fifty.batchCalls).toBeLessThanOrEqual(Math.ceil(WINDOW_MS / (0.7 * 750)))
    // Every pane keeps its own full cadence inside those calls.
    expect(fifty.inspections).toBeGreaterThanOrEqual(0.9 * 50 * one.inspections)
    expect(fifty.detectionLatencyMs!).toBeLessThanOrEqual(one.detectionLatencyMs! + 750)
    expect(fifty.worstGapMs).toBeLessThanOrEqual(one.worstGapMs)
    // Only the pane whose agent exited completes.
    expect(curve.map((point) => point.completions)).toEqual([1, 1, 1])
  })

  it('asks each pane on its own call when the caller has no batch inspector', async () => {
    const fifty = createPanes(50, { visible: true, live: true, agent: true })
    await vi.advanceTimersByTimeAsync(WINDOW_MS)

    expect(inspectedPtyIds(fifty.inspectProcess).size).toBe(50)
    expect(fifty.inspectProcess.mock.calls.length).toBeGreaterThanOrEqual(50 * 50)
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
    await vi.advanceTimersByTimeAsync(5_000)
    coordinators.forEach((c) => c.dispose())
    const callsAtDispose = inspectProcess.mock.calls.length

    await vi.advanceTimersByTimeAsync(WINDOW_MS)

    expect(callsAtDispose).toBeGreaterThan(0)
    expect(inspectProcess.mock.calls.length).toBe(callsAtDispose)
    expect(vi.getTimerCount()).toBe(0)
  })
})
