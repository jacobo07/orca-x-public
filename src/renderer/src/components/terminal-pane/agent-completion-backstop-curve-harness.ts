/*
 * Resource curve of the process-exit backstop at N live agent panes (Resource Elasticity).
 * Reusable by the density lab: it reports scheduler, transport and detection cost separately.
 */
import { vi } from 'vitest'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import { processResult } from './agent-completion-coordinator-test-harness'
import type { AgentCompletionCoordinator } from './agent-completion-coordinator-types'

export const BACKSTOP_CURVE_WINDOW_MS = 60_000
const EXIT_AT_MS = 30_000

export type BackstopCurvePoint = {
  panes: number
  timers: number
  singleCalls: number
  worstGapMs: number
  // Why null: the backstop never noticed the exit inside the window.
  detectionLatencyMs: number | null
  completions: number
}

export type BackstopCurveRig = {
  coordinators: AgentCompletionCoordinator[]
  exit: (index: number) => void
  inspectProcess: ReturnType<typeof vi.fn>
  inspectedAt: Map<string, number[]>
  completedAt: Map<number, number>
  startedAt: number
}

export function createBackstopCurveRig(count: number): BackstopCurveRig {
  const exited = new Set<string>()
  const inspectedAt = new Map<string, number[]>()
  const completedAt = new Map<number, number>()
  const startedAt = Date.now()
  const inspectProcess = vi.fn(async (_settings: unknown, ptyId: string) => {
    const times = inspectedAt.get(ptyId) ?? []
    times.push(Date.now() - startedAt)
    inspectedAt.set(ptyId, times)
    return processResult(exited.has(ptyId) ? null : 'codex')
  })
  const coordinators = Array.from({ length: count }, (_, index) => {
    const coordinator = createAgentCompletionCoordinator({
      paneKey: `tab-${index}:leaf-1`,
      getPtyId: () => `pty-${index}`,
      getSettings: () => null,
      inspectProcess,
      // Why: hooks and titles never report completion here, so only the backstop can.
      dispatchCompletion: () => {
        if (!completedAt.has(index)) {
          completedAt.set(index, Date.now() - startedAt)
        }
      },
      isLive: () => true,
      shouldPollProcessCadence: () => true
    })
    coordinator.startProcessTracking()
    coordinator.observeTitle('Codex working')
    return coordinator
  })
  return {
    coordinators,
    exit: (index) => exited.add(`pty-${index}`),
    inspectProcess,
    inspectedAt,
    completedAt,
    startedAt
  }
}

/** Runs the window with the last pane's agent exiting halfway, silently. */
export async function measureBackstopCurve(count: number): Promise<BackstopCurvePoint> {
  // Why peak, not a point reading: queued panes clear their timer while waiting, so an instant undercounts.
  const live = new Set<unknown>()
  let timers = 0
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const setSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    handler: () => void,
    delay?: number
  ) => {
    const handle: unknown = originalSetTimeout(() => {
      live.delete(handle)
      handler()
    }, delay)
    live.add(handle)
    timers = Math.max(timers, live.size)
    return handle
  }) as typeof setTimeout)
  const clearSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((handle) => {
    live.delete(handle)
    originalClearTimeout(handle)
  }) as typeof clearTimeout)
  const rig = createBackstopCurveRig(count)
  await vi.advanceTimersByTimeAsync(EXIT_AT_MS)
  rig.exit(count - 1)
  await vi.advanceTimersByTimeAsync(BACKSTOP_CURVE_WINDOW_MS - EXIT_AT_MS)
  setSpy.mockRestore()
  clearSpy.mockRestore()
  let worstGapMs = 0
  for (const times of rig.inspectedAt.values()) {
    for (let k = 1; k < times.length; k++) {
      worstGapMs = Math.max(worstGapMs, times[k]! - times[k - 1]!)
    }
  }
  const completed = rig.completedAt.get(count - 1)
  const point: BackstopCurvePoint = {
    panes: count,
    timers,
    singleCalls: rig.inspectProcess.mock.calls.length,
    worstGapMs,
    detectionLatencyMs: completed === undefined ? null : completed - EXIT_AT_MS,
    completions: rig.completedAt.size
  }
  rig.coordinators.forEach((c) => c.dispose())
  return point
}
