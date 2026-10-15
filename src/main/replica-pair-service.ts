// One authority for comparing a project's setups: each non-anchor setup against the project's local anchor
// setup over the app's SSH relay session, folded into the evidence-only state model (rows 62, 63).
import { createHash } from 'node:crypto'
import { parseExecutionHostId } from '../shared/execution-host'
import type { ProjectHostSetup } from '../shared/project-types'
import type {
  ReplicaPairCompareResult,
  ReplicaPairRelationsResult,
  ReplicaPairView
} from '../shared/replica-pair-view'
import {
  deriveReplicaRelation,
  isReplicaRelationHealthy,
  type ReplicaFacts,
  type ReplicaRelation,
  type ReplicaUnknownReason
} from '../shared/workspace-replica-state'
import {
  compareWithSshRelayReplica,
  relationFromComparison,
  type ReplicaComparisonResult,
  type SshRelaySessionDeps
} from './replica-comparison-service'
import { readLocalReplicaFacts, type LocalReplicaRead } from './replica-local-facts'
import {
  comparisonFoundEqualTips,
  readRemoteWorktreeFact,
  UNREAD_REMOTE_WORKTREE
} from './replica-remote-facts'
import { getSshConnectionGeneration } from './ssh/ssh-connection-generation'

export type ReplicaPairServiceDeps = {
  listProjectHostSetups: () => readonly ProjectHostSetup[]
  /** Passed straight to compareWithSshRelayReplica; production leaves it out and gets the live SSH session. */
  sshSession?: Partial<SshRelaySessionDeps>
  now?: () => number
  readLocalFacts?: typeof readLocalReplicaFacts
  readRemoteWorktreeFact?: typeof readRemoteWorktreeFact
}

export type ReplicaPairService = {
  compare(args: {
    projectId: string
    setupId?: string
  }): Promise<Extract<ReplicaPairCompareResult, { status: 'ok' | 'not-found' }>>
  /** Every non-anchor setup of every project: stored answers re-fenced against the current local tip, never a clock. */
  relations(): Promise<Extract<ReplicaPairRelationsResult, { status: 'ok' }>>
}

type StoredPair = {
  anchorId: string
  local: ReplicaFacts
  remote: ReplicaFacts
  result: ReplicaComparisonResult
}

type PairOutcome = { view: ReplicaPairView; stored: StoredPair | null }

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

function remoteFactsOf(setup: ProjectHostSetup, result: ReplicaComparisonResult | null, worktree = UNREAD_REMOTE_WORKTREE): ReplicaFacts {
  const sha = result?.evidence?.observedTips[1] ?? UNREAD_REMOTE_TIP
  return {
    setupId: setup.id,
    hostId: setup.hostId,
    tip: { kind: 'commit', sha, ref: 'HEAD' },
    worktree
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

// Why: loaded on demand so this module stays importable without the Electron-bound SSH layer.
const defaultGetMultiplexer: SshRelaySessionDeps['getMultiplexer'] = async (id) =>
  (await import('./ipc/ssh')).getActiveMultiplexer(id)

function unknownView(
  setup: ProjectHostSetup,
  anchor: ProjectHostSetup | undefined,
  reason: ReplicaUnknownReason
): ReplicaPairView {
  const folder: ReplicaFacts = { kind: 'folder' }
  const relation: ReplicaRelation = { kind: 'unknown', reason }
  return viewOf(setup, anchor, folder, folder, relation, false)
}

// Pure function of the setup list, so it is recomputed on every read and can never be stale.
function structuralReason(
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

function localTipOf(f: ReplicaFacts): string | null {
  return f.kind !== 'folder' && (f.tip.kind === 'commit' || f.tip.kind === 'detached') ? f.tip.sha : null
}

export function createReplicaPairService(deps: ReplicaPairServiceDeps): ReplicaPairService {
  const readLocalFacts = deps.readLocalFacts ?? readLocalReplicaFacts
  const getMultiplexer = deps.sshSession?.getMultiplexer ?? defaultGetMultiplexer
  const getGeneration = deps.sshSession?.getGeneration ?? getSshConnectionGeneration
  const readRemoteWorktree = deps.readRemoteWorktreeFact ?? readRemoteWorktreeFact
  // Why: a second compare of a setup that is mid-flight joins it, so one setup never holds two relay exports.
  const inFlight = new Map<string, Promise<ReplicaPairView>>()
  // Memory only: the last answer per setup, re-fenced on every read. Losing it costs one re-compare.
  const stored = new Map<string, StoredPair>()

  const lazyAnchorRead = (anchor: ProjectHostSetup): (() => Promise<LocalReplicaRead>) => {
    let pending: Promise<LocalReplicaRead> | null = null
    return () => {
      pending ??= readLocalFacts({
        setupId: anchor.id,
        hostId: anchor.hostId,
        path: anchor.path,
        ...(anchor.kind ? { kind: anchor.kind } : {})
      })
      return pending
    }
  }

  async function comparePair(
    setup: ProjectHostSetup,
    anchor: ProjectHostSetup | undefined,
    readAnchor: () => Promise<LocalReplicaRead>
  ): Promise<PairOutcome> {
    const structural = structuralReason(setup, anchor)
    const parsed = parseExecutionHostId(setup.hostId)
    if (structural || !anchor || parsed?.kind !== 'ssh') {
      return { view: unknownView(setup, anchor, structural ?? 'no-comparison-site'), stored: null }
    }
    const connectionId = setup.connectionId ?? parsed.targetId
    // Why: compareWithSshRelayReplica reads a missing multiplexer as an old relay, which would mislabel an unconnected host.
    const mux = await getMultiplexer(connectionId)
    if (!mux || mux.isDisposed()) {
      return { view: unknownView(setup, anchor, 'host-unreachable'), stored: null }
    }
    const anchorRead = await readAnchor()
    const local = anchorFactsOf(anchorRead)
    if (localTipOf(local) === null) {
      const remote = remoteFactsOf(setup, null)
      const relation = deriveReplicaRelation(local, remote)
      return { view: viewOf(setup, anchor, local, remote, relation, false), stored: null }
    }
    const result = await compareWithSshRelayReplica({
      connectionId,
      localRepoPath: anchor.path,
      remoteRepoPath: setup.path,
      hostKey: replicaHostKey(setup.hostId),
      ...(deps.now ? { now: deps.now } : {}),
      deps: { ...deps.sshSession, getMultiplexer: () => mux }
    })
    // Why: the same multiplexer-bound request and generation as the comparison, so the sync.v1 probe is shared.
    const worktree = comparisonFoundEqualTips(result)
      ? await readRemoteWorktree({
          connectionId,
          generation: getGeneration(connectionId),
          request: (method, params, options) => mux.request(method, params, options),
          repoPath: setup.path
        })
      : UNREAD_REMOTE_WORKTREE
    const remote = remoteFactsOf(setup, result, worktree)
    const relation = foldPair(local, anchorRead.shallow, remote, result)
    return {
      view: viewOf(setup, anchor, local, remote, relation, result.evidence !== null),
      stored: { anchorId: anchor.id, local, remote, result }
    }
  }

  function pairFor(
    setup: ProjectHostSetup,
    anchor: ProjectHostSetup | undefined,
    readAnchor: () => Promise<LocalReplicaRead>
  ): Promise<ReplicaPairView> {
    const joined = inFlight.get(setup.id)
    if (joined) {
      return joined
    }
    const started = comparePair(setup, anchor, readAnchor)
      .then((outcome) => {
        // A compare that reached no comparison also retires the older answer it replaces.
        if (outcome.stored) {
          stored.set(setup.id, outcome.stored)
        } else {
          stored.delete(setup.id)
        }
        return outcome.view
      })
      // One setup's failure is that setup's unknown; it never rejects the project call.
      .catch((): ReplicaPairView => {
        stored.delete(setup.id)
        return unknownView(setup, anchor, 'transfer-interrupted')
      })
      .finally(() => inFlight.delete(setup.id))
    inFlight.set(setup.id, started)
    return started
  }

  // Why: re-derived against the current anchor so a moved local tip reads evidence-stale, never the old relation.
  function refenced(
    entry: StoredPair,
    setup: ProjectHostSetup,
    anchor: ProjectHostSetup,
    read: LocalReplicaRead
  ): ReplicaPairView {
    const local = anchorFactsOf(read)
    const moved = localTipOf(local) !== localTipOf(entry.local)
    // A failure that carried no evidence has no tips for the model to fence, so the fence is checked here.
    const relation: ReplicaRelation =
      moved && !entry.result.evidence
        ? { kind: 'unknown', reason: 'evidence-stale' }
        : foldPair(local, read.shallow, entry.remote, entry.result)
    return viewOf(setup, anchor, local, entry.remote, relation, entry.result.evidence !== null)
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
      // Read lazily and once per call: arms that never reach the anchor's history spend no git.
      const readAnchor = anchor ? lazyAnchorRead(anchor) : () => Promise.reject(new Error('no anchor setup'))
      const pairs = await Promise.all(targets.map((s) => pairFor(s, anchor, readAnchor)))
      return { status: 'ok', pairs }
    },

    async relations() {
      const all = deps.listProjectHostSetups()
      const live = new Set(all.map((s) => s.id))
      for (const id of [...stored.keys()]) {
        if (!live.has(id)) {
          stored.delete(id)
        }
      }
      const byProject = new Map<string, ProjectHostSetup[]>()
      for (const setup of all) {
        byProject.set(setup.projectId, [...(byProject.get(setup.projectId) ?? []), setup])
      }
      const pairs: ReplicaPairView[] = []
      for (const setups of byProject.values()) {
        const anchor = pickAnchor(setups)
        let readAnchor: (() => Promise<LocalReplicaRead>) | null = null
        for (const setup of setups.filter((s) => s.id !== anchor?.id)) {
          const entry = stored.get(setup.id)
          const structural = structuralReason(setup, anchor)
          if (entry && (structural || entry.anchorId !== anchor?.id)) {
            stored.delete(setup.id)
          }
          const kept = structural ? undefined : stored.get(setup.id)
          if (structural || !kept || !anchor) {
            pairs.push(unknownView(setup, anchor, structural ?? 'not-compared'))
            continue
          }
          // The anchor is read only once a stored answer needs fencing against it.
          readAnchor ??= lazyAnchorRead(anchor)
          pairs.push(refenced(kept, setup, anchor, await readAnchor()))
        }
      }
      return { status: 'ok', pairs }
    }
  }
}
