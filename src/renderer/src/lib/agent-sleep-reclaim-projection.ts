import type {
  MemorySnapshot,
  ProcessMemoryMetric,
  ProcessMemorySample,
  ProcessPresenceProbe,
  SessionMemory
} from '../../../shared/process-stats-types'

/**
 * Resource truth for the sleep-reclaim flow.
 *
 * The memory dashboard may render an unmeasured session as a zero row; a plan a
 * user authorizes destruction from may not. Everything here keeps "we measured
 * nothing" distinct from "it costs nothing", and carries the collector's own
 * `processMemoryMetric` label rather than inventing a unit.
 *
 * This module never decides whether a candidate may sleep. The hibernation
 * planner is the only admission authority; a footprint can order candidates,
 * never admit one.
 */

export type ReclaimUnknownReason =
  /** Collector had no pid yet, so its subtree was never walked. */
  | 'no-pid'
  /** Pid known, but no process in the host sweep — exited, or the sweep missed it. */
  | 'process-not-found'
  /** No local row at all: SSH-backed sessions run off-host and are not swept. */
  | 'not-locally-measured'
  /** The whole snapshot is untrustworthy, so every footprint is unknown. */
  | 'snapshot-unusable'

export type SleepReclaimFootprint =
  | {
      known: true
      bytes: number
      metric: ProcessMemoryMetric
      /** The exact processes behind `bytes`; absent when the host did not list them. */
      processes?: ProcessMemorySample[]
    }
  | { known: false; reason: ReclaimUnknownReason }

export type SleepReclaimEstimate = {
  /** null when no snapshot exists yet, so the unit is genuinely unknowable. */
  metric: ProcessMemoryMetric | null
  /** Sum over candidates we actually measured. Never includes an unknown as 0. */
  knownBytes: number
  knownCount: number
  /** Unknowns stay counted and reasoned, never folded into knownBytes. */
  unknownCount: number
  unknownReasons: ReclaimUnknownReason[]
}

export type ObservedReclaimUnmeasuredReason =
  /** No pane was actually slept, so there is nothing to observe. */
  | 'nothing-slept'
  /** No slept pane had a measured process list before the effect. */
  | 'no-baseline'
  /** The follow-up sweep could not be asked for or did not answer. */
  | 'sweep-unavailable'
  /** The follow-up sweep ran and listed nothing — absence there proves nothing. */
  | 'sweep-failed'
  /** The follow-up sweep began before the effect finished. */
  | 'sweep-predates-effect'
  /** Before and after were measured with different per-process metrics. */
  | 'metric-changed'

/**
 * What a follow-up sweep proved about the processes of panes that actually slept.
 *
 * `bytes` is the pre-effect footprint of those processes that a usable sweep,
 * started after the effect, no longer lists. It is not a system free-memory
 * change: other processes and the OS move that independently.
 */
export type ObservedReclaim =
  | {
      status: 'measured'
      metric: ProcessMemoryMetric
      bytes: number
      /** Slept panes whose processes were compared. */
      measuredPaneCount: number
      /** Slept panes with no pre-effect process list; they contribute no bytes. */
      unmeasuredPaneCount: number
      /** Baseline processes the sweep still lists — lingering, or a reused pid. Never counted. */
      stillRunningProcessCount: number
    }
  | {
      status: 'unmeasured'
      reason: ObservedReclaimUnmeasuredReason
      sleptPaneCount: number
    }

/**
 * A failed instrument must not read as "nothing is using memory". The collector
 * names a failed sweep; app memory alone cannot, because Electron's own metrics
 * survive it. The zero-app check still covers snapshots that predate the field.
 */
export function isSnapshotUsable(snapshot: MemorySnapshot | null | undefined): boolean {
  return (
    Boolean(snapshot) &&
    (snapshot as MemorySnapshot).processSweep !== 'failed' &&
    (snapshot as MemorySnapshot).app.memory > 0
  )
}

function findSessionByPaneKey(snapshot: MemorySnapshot, paneKey: string): SessionMemory | null {
  for (const worktree of snapshot.worktrees) {
    for (const session of worktree.sessions) {
      if (session.paneKey === paneKey) {
        return session
      }
    }
  }
  return null
}

export function projectCandidateFootprint(
  paneKey: string,
  snapshot: MemorySnapshot | null | undefined
): SleepReclaimFootprint {
  if (!isSnapshotUsable(snapshot)) {
    return { known: false, reason: 'snapshot-unusable' }
  }
  const usable = snapshot as MemorySnapshot
  const session = findSessionByPaneKey(usable, paneKey)
  if (!session) {
    return { known: false, reason: 'not-locally-measured' }
  }
  // Why: the collector writes `pid ?? 0`, so 0 is its "pid not published" signal.
  if (session.pid === 0) {
    return { known: false, reason: 'no-pid' }
  }
  if (session.memory <= 0) {
    return { known: false, reason: 'process-not-found' }
  }
  return {
    known: true,
    bytes: session.memory,
    metric: usable.processMemoryMetric,
    ...(session.processes && session.processes.length > 0 ? { processes: session.processes } : {})
  }
}

export function summarizeReclaimEstimate(
  footprints: readonly SleepReclaimFootprint[],
  metric: ProcessMemoryMetric | null
): SleepReclaimEstimate {
  let knownBytes = 0
  let knownCount = 0
  const unknownReasons: ReclaimUnknownReason[] = []
  for (const footprint of footprints) {
    if (footprint.known) {
      knownBytes += footprint.bytes
      knownCount += 1
    } else if (!unknownReasons.includes(footprint.reason)) {
      unknownReasons.push(footprint.reason)
    }
  }
  return {
    metric,
    knownBytes,
    knownCount,
    unknownCount: footprints.length - knownCount,
    unknownReasons
  }
}

/**
 * The one comparability authority for post-effect reclaim.
 *
 * `slept` must be the footprints the user was shown for panes whose effect
 * outcome was `slept` — never the whole plan. A pid is counted only when a
 * usable sweep that began after `effectEndedAt` does not list it: absence
 * there cannot be our process, whatever the pid is now. A listed pid may be
 * ours lingering or a reused number, so it is never counted either way.
 * Host identity is not compared: the collector and the probe are the same
 * local host by construction, and remote panes have no footprint to carry.
 */
export function measureObservedReclaim({
  slept,
  probe,
  effectEndedAt
}: {
  slept: readonly SleepReclaimFootprint[]
  probe: ProcessPresenceProbe | null
  effectEndedAt: number
}): ObservedReclaim {
  const sleptPaneCount = slept.length
  const unmeasured = (reason: ObservedReclaimUnmeasuredReason): ObservedReclaim => ({
    status: 'unmeasured',
    reason,
    sleptPaneCount
  })
  if (sleptPaneCount === 0) {
    return unmeasured('nothing-slept')
  }
  const baseline = collectBaselineProcesses(slept)
  if (baseline.paneCount === 0) {
    return unmeasured('no-baseline')
  }
  if (probe === null) {
    return unmeasured('sweep-unavailable')
  }
  if (probe.sweep !== 'measured') {
    return unmeasured('sweep-failed')
  }
  if (probe.sweepStartedAt < effectEndedAt) {
    return unmeasured('sweep-predates-effect')
  }
  if (baseline.metrics.size !== 1 || !baseline.metrics.has(probe.metric)) {
    return unmeasured('metric-changed')
  }
  const present = new Set(probe.presentPids)
  let bytes = 0
  let stillRunningProcessCount = 0
  for (const process of baseline.processes.values()) {
    if (present.has(process.pid)) {
      stillRunningProcessCount += 1
    } else {
      bytes += process.memory
    }
  }
  return {
    status: 'measured',
    metric: probe.metric,
    bytes,
    measuredPaneCount: baseline.paneCount,
    unmeasuredPaneCount: sleptPaneCount - baseline.paneCount,
    stillRunningProcessCount
  }
}

/** Pids the follow-up sweep must be asked about. */
export function listBaselinePids(slept: readonly SleepReclaimFootprint[]): number[] {
  return [...collectBaselineProcesses(slept).processes.keys()]
}

function collectBaselineProcesses(slept: readonly SleepReclaimFootprint[]): {
  processes: Map<number, ProcessMemorySample>
  metrics: Set<ProcessMemoryMetric>
  paneCount: number
} {
  const processes = new Map<number, ProcessMemorySample>()
  const metrics = new Set<ProcessMemoryMetric>()
  let paneCount = 0
  for (const footprint of slept) {
    if (!footprint.known || !footprint.processes || footprint.processes.length === 0) {
      continue
    }
    paneCount += 1
    metrics.add(footprint.metric)
    for (const process of footprint.processes) {
      // Why: the collector already claims each pid once; keying by pid keeps that if two plans overlap.
      processes.set(process.pid, process)
    }
  }
  return { processes, metrics, paneCount }
}
