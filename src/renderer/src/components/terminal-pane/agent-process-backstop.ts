/*
 * One process-exit backstop per window. Each pane keeps its own completion state and cadence
 * but registers a due time here instead of owning a timer, and due panes share one inspection
 * call per tick. Hooks and titles never pass through this: it only repairs what they miss.
 */
import { e2eConfig } from '@/lib/e2e-config'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-inspection'
import type { RuntimeTerminalProcessInspectionOutcome } from '@/runtime/runtime-terminal-inspection-batch'

type Settings = Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined

export type BackstopInspectProcess = (
  settings: Settings,
  ptyId: string
) => Promise<RuntimeTerminalProcessInspection>

export type BackstopInspectProcesses = (
  settings: Settings,
  ptyIds: string[]
) => Promise<Map<string, RuntimeTerminalProcessInspectionOutcome>>

export type BackstopInspectionOutcome =
  | RuntimeTerminalProcessInspectionOutcome
  // Why: the pane was disposed before its batch left, so nothing was asked.
  | { status: 'skipped' }

export type BackstopInspectionRequest = {
  ptyId: string
  settings: Settings
  inspectProcess: BackstopInspectProcess
  inspectProcesses?: BackstopInspectProcesses
  isActive: () => boolean
}

export type AgentProcessBackstopSnapshot = {
  timerArmed: boolean
  scheduled: number
  pending: number
  inFlightGroups: number
  ticks: number
  batchCalls: number
  singleCalls: number
}

export type AgentProcessBackstop = {
  schedule: (owner: object, delayMs: number, onDue: () => void) => void
  cancel: (owner: object) => void
  inspect: (request: BackstopInspectionRequest) => Promise<BackstopInspectionOutcome>
  snapshot: () => AgentProcessBackstopSnapshot
  dispose: () => void
}

type Due = { dueAt: number; alignAt: number; onDue: () => void }
type Waiter = BackstopInspectionRequest & { resolve: (outcome: BackstopInspectionOutcome) => void }

// Why: a pane due within this share of its interval joins the current tick, so panes converge on one call.
const ALIGN_FRACTION = 0.3

export function createAgentProcessBackstop(): AgentProcessBackstop {
  const scheduled = new Map<object, Due>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let timerDueAt = Number.POSITIVE_INFINITY
  let waiting: Waiter[] = []
  let flushQueued = false
  // Why keyed by inspector and runtime target: one slow host must not stall another's panes.
  const inFlight = new Set<string>()
  const inspectorIds = new Map<unknown, number>()
  let ticks = 0
  let batchCalls = 0
  let singleCalls = 0

  function disarm(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    timerDueAt = Number.POSITIVE_INFINITY
  }

  function arm(): void {
    if (scheduled.size === 0) {
      disarm()
      return
    }
    let next = Number.POSITIVE_INFINITY
    for (const due of scheduled.values()) {
      next = Math.min(next, due.dueAt)
    }
    if (timer !== null && timerDueAt <= next) {
      return
    }
    disarm()
    timerDueAt = next
    timer = setTimeout(fire, Math.max(0, next - Date.now()))
  }

  function fire(): void {
    timer = null
    timerDueAt = Number.POSITIVE_INFINITY
    ticks += 1
    const now = Date.now()
    const ready: (() => void)[] = []
    for (const [owner, due] of scheduled) {
      if (due.alignAt <= now) {
        scheduled.delete(owner)
        ready.push(due.onDue)
      }
    }
    for (const onDue of ready) {
      try {
        onDue()
      } catch (error) {
        // Why: one pane's fault must not skip the others in this tick.
        console.error('[agent-process-backstop] pane tick failed', error)
      }
    }
    // Why: send this tick's panes now; the queued microtask then finds nothing left.
    flush()
    arm()
  }

  function groupKey(request: BackstopInspectionRequest): string {
    const inspector = request.inspectProcesses ?? request.inspectProcess
    let id = inspectorIds.get(inspector)
    if (id === undefined) {
      id = inspectorIds.size
      inspectorIds.set(inspector, id)
    }
    return `${id}:${request.settings?.activeRuntimeEnvironmentId ?? ''}`
  }

  function queueFlush(): void {
    if (!flushQueued) {
      flushQueued = true
      queueMicrotask(flush)
    }
  }

  function flush(): void {
    flushQueued = false
    const requests = waiting
    waiting = []
    const groups = new Map<string, Waiter[]>()
    for (const request of requests) {
      if (!request.isActive()) {
        request.resolve({ status: 'skipped' })
        continue
      }
      const key = groupKey(request)
      if (inFlight.has(key)) {
        // Why: never stack a second call behind a slow one; these ride the next.
        waiting.push(request)
        continue
      }
      const group = groups.get(key) ?? []
      group.push(request)
      groups.set(key, group)
    }
    for (const [key, group] of groups) {
      void runGroup(key, group)
    }
  }

  async function runGroup(key: string, group: Waiter[]): Promise<void> {
    inFlight.add(key)
    try {
      const inspectProcesses = group[0]!.inspectProcesses
      await (inspectProcesses ? runBatch(inspectProcesses, group) : runSingles(group))
    } finally {
      inFlight.delete(key)
      if (waiting.length > 0) {
        queueFlush()
      }
    }
  }

  async function runBatch(inspectProcesses: BackstopInspectProcesses, group: Waiter[]) {
    const ptyIds = [...new Set(group.map((request) => request.ptyId))]
    let outcomes: Map<string, RuntimeTerminalProcessInspectionOutcome> | null = null
    batchCalls += 1
    try {
      outcomes = await inspectProcesses(group[0]!.settings, ptyIds)
    } catch {
      outcomes = null
    }
    for (const request of group) {
      request.resolve(outcomes?.get(request.ptyId) ?? { status: 'failed' })
    }
  }

  // Why: only callers without a batch inspector (older wiring, tests) pay one call per pane.
  async function runSingles(group: Waiter[]): Promise<void> {
    await Promise.all(
      group.map(async (request) => {
        singleCalls += 1
        try {
          const inspection = await request.inspectProcess(request.settings, request.ptyId)
          request.resolve({ status: 'inspected', inspection })
        } catch {
          request.resolve({ status: 'failed' })
        }
      })
    )
  }

  return {
    schedule(owner, delayMs, onDue) {
      const dueAt = Date.now() + delayMs
      scheduled.set(owner, { dueAt, alignAt: dueAt - Math.floor(delayMs * ALIGN_FRACTION), onDue })
      arm()
    },
    cancel(owner) {
      if (scheduled.delete(owner)) {
        arm()
      }
    },
    inspect(request) {
      return new Promise((resolve) => {
        waiting.push({ ...request, resolve })
        queueFlush()
      })
    },
    snapshot: () => ({
      timerArmed: timer !== null,
      scheduled: scheduled.size,
      pending: waiting.length,
      inFlightGroups: inFlight.size,
      ticks,
      batchCalls,
      singleCalls
    }),
    dispose() {
      scheduled.clear()
      disarm()
      for (const request of waiting) {
        request.resolve({ status: 'skipped' })
      }
      waiting = []
    }
  }
}

let windowBackstop: AgentProcessBackstop | null = null

export function getAgentProcessBackstop(): AgentProcessBackstop {
  if (!windowBackstop) {
    windowBackstop = createAgentProcessBackstop()
    if (e2eConfig.exposeStore && typeof window !== 'undefined') {
      const backstop = windowBackstop
      ;(window as { __orcaAgentProcessBackstop?: unknown }).__orcaAgentProcessBackstop = () =>
        backstop.snapshot()
    }
  }
  return windowBackstop
}

export function resetAgentProcessBackstopForTests(): void {
  windowBackstop?.dispose()
  windowBackstop = null
}
