// One authority for comparing a project's setups: each non-anchor setup against the project's local anchor
// setup over the app's SSH relay session, folded into the evidence-only state model (rows 62, 63).
import { createHash } from 'node:crypto'
import { parseExecutionHostId } from '../shared/execution-host'
import type { ProjectHostSetup } from '../shared/project-types'
import type { ReplicaPairCompareResult, ReplicaPairView } from '../shared/replica-pair-view'
import {
  deriveReplicaRelation,
  isReplicaRelationHealthy,
  type ReplicaFacts,
  type ReplicaRelation
} from '../shared/workspace-replica-state'
import {
  compareWithSshRelayReplica,
  relationFromComparison,
  type ReplicaComparisonResult,
  type SshRelaySessionDeps
} from './replica-comparison-service'
import { readLocalReplicaFacts, type LocalReplicaRead } from './replica-local-facts'

export type ReplicaPairServiceDeps = {
  listProjectHostSetups: () => readonly ProjectHostSetup[]
  /** Passed straight to compareWithSshRelayReplica; production leaves it out and gets the live SSH session. */
  sshSession?: Partial<SshRelaySessionDeps>
  now?: () => number
  readLocalFacts?: typeof readLocalReplicaFacts
}

export type ReplicaPairService = {
  compare(args: {
    projectId: string
    setupId?: string
  }): Promise<Extract<ReplicaPairCompareResult, { status: 'ok' | 'not-found' }>>
}

// Why: the model needs a tip to reach the evidence branch; this value is never published (unknown carries no tips).
const UNREAD_REMOTE_TIP = '0'.repeat(40)

/** Ref-safe, deterministic key per host: two hosts that sanitize alike still get distinct namespaces. */
export function replicaHostKey(hostId: string): string {
  const safe = hostId
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^[.-]/, '_')
    .slice(0, 48)
  return `${safe}-${createHash('sha256').update(hostId).digest('hex').slice(0, 10)}`
}

function pickAnchor(setups: readonly ProjectHostSetup[]): ProjectHostSetup | undefined {
  return setups
    .filter((s) => s.hostId === 'local')
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0]
}

function remoteFactsOf(setup: ProjectHostSetup, result: ReplicaComparisonResult | null): ReplicaFacts {
  const sha = result?.evidence?.observedTips[1] ?? UNREAD_REMOTE_TIP
  return {
    setupId: setup.id,
    hostId: setup.hostId,
    tip: { kind: 'commit', sha, ref: 'HEAD' },
    // Why: the remote worktree is read through the relay gate in a later plan; until then equal tips are never healthy.
    worktree: { kind: 'unknown', reason: 'remote-worktree-not-read' }
  }
}

// Why: the model names a non-repository path as a folder, which is the one fact that yields not-a-git-repo.
function anchorFactsOf(read: LocalReplicaRead): ReplicaFacts {
  const f = read.facts
  return f.kind !== 'folder' && f.tip.kind === 'unknown' && f.tip.reason === 'not-a-git-repo'
    ? { kind: 'folder' }
    : f
}

function foldPair(
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

function viewOf(
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

export function createReplicaPairService(deps: ReplicaPairServiceDeps): ReplicaPairService {
  const readLocalFacts = deps.readLocalFacts ?? readLocalReplicaFacts

  async function comparePair(
    setup: ProjectHostSetup,
    anchor: ProjectHostSetup | undefined,
    anchorRead: LocalReplicaRead | null
  ): Promise<ReplicaPairView> {
    const parsed = parseExecutionHostId(setup.hostId)
    if (!anchor || !anchorRead || parsed?.kind !== 'ssh') {
      const remote = remoteFactsOf(setup, null)
      const local: ReplicaFacts = anchorRead ? anchorFactsOf(anchorRead) : { kind: 'folder' }
      return viewOf(setup, anchor, local, remote, { kind: 'unknown', reason: 'not-compared' }, false)
    }
    const local = anchorFactsOf(anchorRead)
    const usable =
      local.kind !== 'folder' && (local.tip.kind === 'commit' || local.tip.kind === 'detached')
    if (!usable) {
      const remote = remoteFactsOf(setup, null)
      return viewOf(setup, anchor, local, remote, deriveReplicaRelation(local, remote), false)
    }
    const result = await compareWithSshRelayReplica({
      connectionId: setup.connectionId ?? parsed.targetId,
      localRepoPath: anchor.path,
      remoteRepoPath: setup.path,
      hostKey: replicaHostKey(setup.hostId),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.sshSession ? { deps: deps.sshSession } : {})
    })
    const remote = remoteFactsOf(setup, result)
    const relation = foldPair(local, anchorRead.shallow, remote, result)
    return viewOf(setup, anchor, local, remote, relation, result.evidence !== null)
  }

  return {
    async compare({ projectId, setupId }) {
      const setups = deps.listProjectHostSetups().filter((s) => s.projectId === projectId)
      if (setups.length === 0) {
        return { status: 'not-found', reason: 'unknown-project' }
      }
      if (setupId !== undefined && !setups.some((s) => s.id === setupId)) {
        return { status: 'not-found', reason: 'unknown-setup' }
      }
      const anchor = pickAnchor(setups)
      const targets = setups.filter((s) => s.id !== anchor?.id && (setupId === undefined || s.id === setupId))
      const anchorRead =
        anchor && targets.length > 0
          ? await readLocalFacts({
              setupId: anchor.id,
              hostId: anchor.hostId,
              path: anchor.path,
              ...(anchor.kind ? { kind: anchor.kind } : {})
            })
          : null
      const pairs = await Promise.all(targets.map((s) => comparePair(s, anchor, anchorRead)))
      return { status: 'ok', pairs }
    }
  }
}
