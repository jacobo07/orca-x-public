// Pure replica state model: facts + SHA-fenced evidence in, closed relation out. No I/O, no time.

export const REPLICA_UNKNOWN_REASONS = [
  'host-unreachable',
  'tip-unknown',
  'unborn',
  'relay-too-old',
  'transport-unsupported-host',
  'no-comparison-site',
  'bundle-too-large',
  'bundle-verify-failed',
  'bundle-heads-mismatch',
  'transfer-interrupted',
  'shallow',
  'evidence-stale',
  'not-compared',
  'not-a-git-repo',
  'worktree-not-verified-clean'
] as const

export type ReplicaUnknownReason = (typeof REPLICA_UNKNOWN_REASONS)[number]

export type TipFact =
  | { kind: 'commit'; sha: string; ref: string }
  | { kind: 'detached'; sha: string }
  | { kind: 'unborn' }
  | { kind: 'unknown'; reason: string }

export type WorktreeFact =
  | { kind: 'clean' }
  | {
      kind: 'dirty'
      staged: number
      unstaged: number
      untracked: number
      unmerged: number
      countsCapped?: true
    }
  | { kind: 'unknown'; reason: string }

export type CapsuleFact =
  | { kind: 'present'; ref: string; sha: string; baseTip: string; partial: boolean }
  | { kind: 'damaged'; ref: string; reason: string }

export type ReplicaFacts =
  | { kind: 'folder' }
  | {
      kind?: 'git'
      setupId: string
      hostId: string
      tip: TipFact
      worktree: WorktreeFact
      capsule?: CapsuleFact
    }

export type ReplicaAncestry =
  | { kind: 'same' }
  | { kind: 'ahead'; count: number }
  | { kind: 'behind'; count: number }
  | { kind: 'diverged'; mergeBase: string; aheadCount: number; behindCount: number }
  | { kind: 'unrelated' }

export type ReplicaPairEvidence = {
  /** [A tip sha, B tip sha] as observed when the comparison ran. */
  observedTips: readonly [string, string]
  /** Where the comparison ran. */
  site: string
  outcome: { ok: true; ancestry: ReplicaAncestry } | { ok: false; reason: string }
  /** Display only; never read by the classifier. */
  observedAt?: number
}

type Observed = { observedTips: readonly [string, string]; site?: string }

export type ReplicaRelation =
  | ({ kind: 'same' } & Observed)
  | ({ kind: 'ahead'; count: number } & Observed)
  | ({ kind: 'behind'; count: number } & Observed)
  | ({ kind: 'diverged'; mergeBase: string; aheadCount: number; behindCount: number } & Observed)
  | ({ kind: 'unrelated' } & Observed)
  | { kind: 'unknown'; reason: ReplicaUnknownReason }

const unknown = (reason: ReplicaUnknownReason): ReplicaRelation => ({ kind: 'unknown', reason })

function asReason(raw: string): ReplicaUnknownReason {
  // A failure reason outside the closed list must not invent a state: it is a failed transfer.
  return (REPLICA_UNKNOWN_REASONS as readonly string[]).includes(raw)
    ? (raw as ReplicaUnknownReason)
    : 'transfer-interrupted'
}

function tipSha(f: Exclude<ReplicaFacts, { kind: 'folder' }>): string | null {
  return f.tip.kind === 'commit' || f.tip.kind === 'detached' ? f.tip.sha : null
}

export function deriveReplicaRelation(
  a: ReplicaFacts,
  b: ReplicaFacts,
  evidence?: ReplicaPairEvidence
): ReplicaRelation {
  if (a.kind === 'folder' || b.kind === 'folder') {
    return unknown('not-a-git-repo')
  }
  for (const f of [a, b]) {
    if (f.tip.kind === 'unknown') {
      return unknown(f.tip.reason === 'host-unreachable' ? 'host-unreachable' : 'tip-unknown')
    }
  }
  if (a.tip.kind === 'unborn' || b.tip.kind === 'unborn') {
    return unknown('unborn')
  }
  const shaA = tipSha(a)
  const shaB = tipSha(b)
  if (shaA === null || shaB === null) {
    return unknown('tip-unknown')
  }
  // Equal tips need no transfer: two rev-parse answers are the evidence.
  if (shaA === shaB) {
    return { kind: 'same', observedTips: [shaA, shaB] }
  }
  if (!evidence) {
    return unknown('not-compared')
  }
  // A moved tip invalidates the old answer; it is never reused (no TTL, no clock).
  if (evidence.observedTips[0] !== shaA || evidence.observedTips[1] !== shaB) {
    return unknown('evidence-stale')
  }
  if (!evidence.outcome.ok) {
    return unknown(asReason(evidence.outcome.reason))
  }
  return { ...evidence.outcome.ancestry, observedTips: evidence.observedTips, site: evidence.site }
}

function isClean(f: ReplicaFacts): boolean {
  return f.kind !== 'folder' && f.worktree.kind === 'clean'
}

export function isReplicaRelationHealthy(
  relation: ReplicaRelation,
  a: ReplicaFacts,
  b: ReplicaFacts
): boolean {
  if (relation.kind !== 'same') {
    return false
  }
  if (a.kind === 'folder' || b.kind === 'folder') {
    return false
  }
  const shaA = tipSha(a)
  const shaB = tipSha(b)
  // Re-check the fence: the predicate does not trust a relation whose tips have moved.
  if (
    shaA === null ||
    shaB === null ||
    relation.observedTips[0] !== shaA ||
    relation.observedTips[1] !== shaB
  ) {
    return false
  }
  return isClean(a) && isClean(b)
}

/**
 * The one publication rule: equal tips with a worktree that is not verified clean are not a healthy `same`,
 * so they publish as unknown. Every consumer of a pair view calls this rather than reading `relation` raw.
 */
export function publishedReplicaRelation(relation: ReplicaRelation, healthy: boolean): ReplicaRelation {
  return relation.kind === 'same' && !healthy ? unknown('worktree-not-verified-clean') : relation
}
