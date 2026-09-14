import type {
  MemorySnapshot,
  ProcessMemoryMetric,
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
  | { known: true; bytes: number; metric: ProcessMemoryMetric }
  | { known: false; reason: ReclaimUnknownReason }

export type SleepReclaimEstimate = {
  metric: ProcessMemoryMetric
  /** Sum over candidates we actually measured. Never includes an unknown as 0. */
  knownBytes: number
  knownCount: number
  /** Unknowns stay counted and reasoned, never folded into knownBytes. */
  unknownCount: number
  unknownReasons: ReclaimUnknownReason[]
}

export type ObservedReclaim = {
  metric: ProcessMemoryMetric
  /** Owned PTY-subtree bytes released. Positive means memory was given back. */
  ownedProcessBytes: number
  /** Orca's own Electron process set. */
  appProcessBytes: number
  /** Host availability delta, labelled by the source the collector used. */
  hostAvailableBytes: number
  hostAvailableSource: MemorySnapshot['host']['availableMemorySource']
}

/**
 * A live Electron app always reports some process memory, so a zero total means
 * the sweep failed and `collectMemorySnapshot` returned its empty fallback. A
 * failed instrument must not read as "nothing is using memory".
 */
export function isSnapshotUsable(snapshot: MemorySnapshot | null | undefined): boolean {
  return Boolean(snapshot) && (snapshot as MemorySnapshot).app.memory > 0
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
  return { known: true, bytes: session.memory, metric: usable.processMemoryMetric }
}

export function summarizeReclaimEstimate(
  footprints: readonly SleepReclaimFootprint[],
  metric: ProcessMemoryMetric
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
 * Three figures, never one. Summing owned-process bytes and host availability
 * would double-count, and Windows may trim or retain pages independently of
 * what a process released.
 */
export function measureObservedReclaim(
  before: MemorySnapshot,
  after: MemorySnapshot
): ObservedReclaim {
  const ownedBefore = sumWorktreeMemory(before)
  const ownedAfter = sumWorktreeMemory(after)
  return {
    metric: after.processMemoryMetric,
    ownedProcessBytes: ownedBefore - ownedAfter,
    appProcessBytes: before.app.memory - after.app.memory,
    hostAvailableBytes: after.host.availableMemory - before.host.availableMemory,
    hostAvailableSource: after.host.availableMemorySource
  }
}

function sumWorktreeMemory(snapshot: MemorySnapshot): number {
  let total = 0
  for (const worktree of snapshot.worktrees) {
    total += worktree.memory
  }
  return total
}
