// Pure pieces of the pair service: the anchor choice, the facts of each side and the published view of a pair.
import { createHash } from 'node:crypto'
import { parseExecutionHostId } from '../shared/execution-host'
import type { ProjectHostSetup } from '../shared/project-types'
import type { ReplicaPairView } from '../shared/replica-pair-view'
import {
  deriveReplicaRelation,
  isReplicaRelationHealthy,
  type ReplicaFacts,
  type ReplicaRelation,
  type ReplicaUnknownReason
} from '../shared/workspace-replica-state'
import { relationFromComparison, type ReplicaComparisonResult } from './replica-comparison-service'
import type { LocalReplicaRead } from './replica-local-facts'
import { UNREAD_REMOTE_WORKTREE } from './replica-remote-facts'

/** Ref-safe, deterministic key per host: two hosts that sanitize alike still get distinct namespaces. */
export function replicaHostKey(hostId: string): string {
  const safe = hostId
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^[.-]/, '_')
    .slice(0, 48)
  return `${safe}-${createHash('sha256').update(hostId).digest('hex').slice(0, 10)}`
}

// Why: the model needs a tip to reach the evidence branch; this value is never published (unknown carries no tips).
const UNREAD_REMOTE_TIP = '0'.repeat(40)

export function pickAnchor(setups: readonly ProjectHostSetup[]): ProjectHostSetup | undefined {
  return setups
    .filter((s) => s.hostId === 'local')
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0]
}

export function remoteFactsOf(
  setup: ProjectHostSetup,
  result: ReplicaComparisonResult | null,
  worktree = UNREAD_REMOTE_WORKTREE
): ReplicaFacts {
  const sha = result?.evidence?.observedTips[1] ?? UNREAD_REMOTE_TIP
  return {
    setupId: setup.id,
    hostId: setup.hostId,
    tip: { kind: 'commit', sha, ref: 'HEAD' },
    worktree
  }
}

// Why: the model names a non-repository path as a folder, which is the one fact that yields not-a-git-repo.
export function anchorFactsOf(read: LocalReplicaRead): ReplicaFacts {
  const f = read.facts
  return f.kind !== 'folder' && f.tip.kind === 'unknown' && f.tip.reason === 'not-a-git-repo'
    ? { kind: 'folder' }
    : f
}

export function foldPair(
  local: ReplicaFacts,
  shallow: boolean,
  remote: ReplicaFacts,
  result: ReplicaComparisonResult
): ReplicaRelation {
  const decided = result.evidence?.outcome
  if (shallow && decided?.ok && decided.ancestry.kind !== 'same' && result.evidence) {
    // A shallow history cannot decide ancestry: transferred objects against it are not the whole graph.
    return deriveReplicaRelation(local, remote, {
      observedTips: result.evidence.observedTips,
      site: 'local',
      outcome: { ok: false, reason: 'shallow' }
    })
  }
  return relationFromComparison(local, remote, result)
}

export function viewOf(
  setup: ProjectHostSetup,
  anchor: ProjectHostSetup | undefined,
  local: ReplicaFacts,
  remote: ReplicaFacts,
  relation: ReplicaRelation,
  observed: boolean
): ReplicaPairView {
  return {
    setupId: setup.id,
    anchorSetupId: anchor?.id ?? null,
    hostId: setup.hostId,
    relation,
    healthy: isReplicaRelationHealthy(relation, local, remote),
    ...(observed && remote.kind !== 'folder' && remote.tip.kind === 'commit'
      ? { remoteTip: remote.tip.sha }
      : {})
  }
}

// Pure function of the setup list, so it is recomputed on every read and can never be stale.
export function structuralReason(
  setup: ProjectHostSetup,
  anchor: ProjectHostSetup | undefined
): ReplicaUnknownReason | null {
  if (!anchor) {
    return 'no-comparison-site'
  }
  // Folder workspaces have no history to compare, whichever side they are on.
  if (setup.kind === 'folder' || anchor.kind === 'folder') {
    return 'not-a-git-repo'
  }
  const parsed = parseExecutionHostId(setup.hostId)
  if (parsed?.kind === 'local') {
    return 'no-comparison-site'
  }
  return parsed?.kind === 'ssh' ? null : 'transport-unsupported-host'
}

export function localTipOf(f: ReplicaFacts): string | null {
  return f.kind !== 'folder' && (f.tip.kind === 'commit' || f.tip.kind === 'detached')
    ? f.tip.sha
    : null
}

export function unknownView(
  setup: ProjectHostSetup,
  anchor: ProjectHostSetup | undefined,
  reason: ReplicaUnknownReason
): ReplicaPairView {
  const folder: ReplicaFacts = { kind: 'folder' }
  const relation: ReplicaRelation = { kind: 'unknown', reason }
  return viewOf(setup, anchor, folder, folder, relation, false)
}
