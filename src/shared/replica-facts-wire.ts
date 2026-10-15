import type { WorktreeFact } from './workspace-replica-state'

export const REPLICA_FACTS_METHOD = 'sync.replicaFacts'
const MAX_REASON_LENGTH = 200

export type ReplicaFactsWireResult =
  | { ok: true; worktree: WorktreeFact }
  | { ok: false; reason: string }

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseWorktree(value: unknown): WorktreeFact | null {
  if (!isRecord(value)) {
    return null
  }
  if (value.kind === 'clean') {
    return { kind: 'clean' }
  }
  if (value.kind === 'unknown') {
    const { reason } = value
    return typeof reason === 'string' && reason.length > 0 && reason.length <= MAX_REASON_LENGTH
      ? { kind: 'unknown', reason }
      : null
  }
  if (value.kind === 'dirty') {
    const { staged, unstaged, untracked, unmerged, countsCapped } = value
    if (!isCount(staged) || !isCount(unstaged) || !isCount(untracked) || !isCount(unmerged)) {
      return null
    }
    if (countsCapped !== undefined && countsCapped !== true) {
      return null
    }
    return {
      kind: 'dirty',
      staged,
      unstaged,
      untracked,
      unmerged,
      ...(countsCapped === true ? { countsCapped: true as const } : {})
    }
  }
  return null
}

/** Strict reader for a relay `sync.replicaFacts` answer; extra keys are ignored, anything else malformed is rejected. */
export function parseReplicaFactsWire(value: unknown): ReplicaFactsWireResult {
  if (!isRecord(value)) {
    return { ok: false, reason: 'answer is not an object' }
  }
  const worktree = parseWorktree(value.worktree)
  return worktree ? { ok: true, worktree } : { ok: false, reason: 'worktree fact is malformed' }
}
