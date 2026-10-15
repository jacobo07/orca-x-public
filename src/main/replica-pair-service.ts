// One authority for comparing a project's setups: each non-anchor setup against the project's local anchor
// setup over the app's SSH relay session, folded into the evidence-only state model (rows 62, 63).
import { parseExecutionHostId } from '../shared/execution-host'
import type { ProjectHostSetup } from '../shared/project-types'
import type {
  ReplicaPairCompareResult,
  ReplicaPairRelationsResult,
  ReplicaPairView
} from '../shared/replica-pair-view'
import {
  deriveReplicaRelation,
  type ReplicaFacts,
  type ReplicaRelation
} from '../shared/workspace-replica-state'
import {
  compareWithSshRelayReplica,
  type ReplicaComparisonResult,
  type SshRelaySessionDeps
} from './replica-comparison-service'
import { readLocalReplicaFacts, type LocalReplicaRead } from './replica-local-facts'
import {
  createReplicaCapsuleOperations,
  type ReplicaCapsuleOperationDeps,
  type ReplicaCapsuleOperations
} from './replica-pair-service-capsule'
import {
  createReplicaSyncOperations,
  type ReplicaSyncOperations
} from './replica-pair-service-sync'
import {
  anchorFactsOf,
  foldPair,
  localTipOf,
  pickAnchor,
  remoteFactsOf,
  replicaHostKey,
  structuralReason,
  unknownView,
  viewOf
} from './replica-pair-views'
import {
  comparisonFoundEqualTips,
  readRemoteWorktreeFact,
  UNREAD_REMOTE_WORKTREE
} from './replica-remote-facts'
import type { GitRun } from './replica-sync'
import { createReplicaWorktreeMutationGuard } from './replica-worktree-mutation-guard'
import { getSshConnectionGeneration } from './ssh/ssh-connection-generation'

export type ReplicaPairServiceDeps = {
  listProjectHostSetups: () => readonly ProjectHostSetup[]
  /** Passed straight to compareWithSshRelayReplica; production leaves it out and gets the live SSH session. */
  sshSession?: Partial<SshRelaySessionDeps>
  now?: () => number
  readLocalFacts?: typeof readLocalReplicaFacts
  readRemoteWorktreeFact?: typeof readRemoteWorktreeFact
  /** Runner for the sync fast-forward; production leaves it out and gets the local one. */
  git?: GitRun
} & Partial<Pick<ReplicaCapsuleOperationDeps, 'capsuleGit' | 'mutationGuard'>>

export type ReplicaPairService = {
  compare(args: {
    projectId: string
    setupId?: string
  }): Promise<Extract<ReplicaPairCompareResult, { status: 'ok' | 'not-found' }>>
  /** Every non-anchor setup of every project: stored answers re-fenced against the current local tip, never a clock. */
  relations(): Promise<Extract<ReplicaPairRelationsResult, { status: 'ok' }>>
} & ReplicaCapsuleOperations &
  ReplicaSyncOperations

type StoredPair = {
  /** Set when the local tip moved under the answer (a sync): the answer is kept only as the fact that it is stale. */
  stale?: true
  anchorId: string
  local: ReplicaFacts
  remote: ReplicaFacts
  result: ReplicaComparisonResult
}

type PairOutcome = { view: ReplicaPairView; stored: StoredPair | null }

export { replicaHostKey }

// Why: loaded on demand so this module stays importable without the Electron-bound SSH layer.
const defaultGetMultiplexer: SshRelaySessionDeps['getMultiplexer'] = async (id) =>
  (await import('./ipc/ssh')).getActiveMultiplexer(id)

export function createReplicaPairService(deps: ReplicaPairServiceDeps): ReplicaPairService {
  const readLocalFacts = deps.readLocalFacts ?? readLocalReplicaFacts
  const getMultiplexer = deps.sshSession?.getMultiplexer ?? defaultGetMultiplexer
  const getGeneration = deps.sshSession?.getGeneration ?? getSshConnectionGeneration
  const readRemoteWorktree = deps.readRemoteWorktreeFact ?? readRemoteWorktreeFact
  // Why: a second compare of a setup that is mid-flight joins it, so one setup never holds two relay exports.
  const inFlight = new Map<string, Promise<PairOutcome>>()
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
    readAnchor: () => Promise<LocalReplicaRead>,
    /** A comparison someone else already made (a sync that found the anchor not behind); no transfer is repeated. */
    known?: ReplicaComparisonResult
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
    const result =
      known ??
      (await compareWithSshRelayReplica({
        connectionId,
        localRepoPath: anchor.path,
        remoteRepoPath: setup.path,
        hostKey: replicaHostKey(setup.hostId),
        ...(deps.now ? { now: deps.now } : {}),
        deps: { ...deps.sshSession, getMultiplexer: () => mux }
      }))
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

  function startComparison(
    setup: ProjectHostSetup,
    anchor: ProjectHostSetup | undefined,
    readAnchor: () => Promise<LocalReplicaRead>,
    known?: ReplicaComparisonResult
  ): Promise<PairOutcome> {
    const started = comparePair(setup, anchor, readAnchor, known)
      .then((outcome) => {
        // A compare that reached no comparison also retires the older answer it replaces.
        if (outcome.stored) {
          stored.set(setup.id, outcome.stored)
        } else {
          stored.delete(setup.id)
        }
        return outcome
      })
      // One setup's failure is that setup's unknown; it never rejects the project call.
      .catch((): PairOutcome => {
        stored.delete(setup.id)
        return { view: unknownView(setup, anchor, 'transfer-interrupted'), stored: null }
      })
      .finally(() => inFlight.delete(setup.id))
    inFlight.set(setup.id, started)
    return started
  }

  function pairFor(
    setup: ProjectHostSetup,
    anchor: ProjectHostSetup | undefined,
    readAnchor: () => Promise<LocalReplicaRead>
  ): Promise<ReplicaPairView> {
    const joined = inFlight.get(setup.id)
    return (joined ?? startComparison(setup, anchor, readAnchor)).then((outcome) => outcome.view)
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
      entry.stale || (moved && !entry.result.evidence)
        ? { kind: 'unknown', reason: 'evidence-stale' }
        : foldPair(local, read.shallow, entry.remote, entry.result)
    return viewOf(
      setup,
      anchor,
      local,
      entry.remote,
      relation,
      !entry.stale && entry.result.evidence !== null
    )
  }

  // Why: one guard for every worktree-mutating method of this service, so two effects never interleave on a worktree.
  const mutationGuard = deps.mutationGuard ?? createReplicaWorktreeMutationGuard()
  const capsules = createReplicaCapsuleOperations({ ...deps, mutationGuard })
  const syncOperations = createReplicaSyncOperations({
    ...deps,
    mutationGuard,
    ledger: {
      async adoptEvidence(setup, anchor, evidence) {
        // Why: never overlap a comparison of the same setup; the evidence is folded through the one comparison path.
        await inFlight.get(setup.id)
        await startComparison(setup, anchor, lazyAnchorRead(anchor), {
          ok: true,
          evidence,
          refs: {}
        })
      },
      markStale(setupId) {
        const entry = stored.get(setupId)
        if (entry) {
          stored.set(setupId, { ...entry, stale: true })
        }
      }
    }
  })

  return {
    ...capsules,
    ...syncOperations,
    async compare({ projectId, setupId }) {
      const setups = deps.listProjectHostSetups().filter((s) => s.projectId === projectId)
      if (setups.length === 0) {
        return { status: 'not-found', reason: 'unknown-project' }
      }
      if (setupId !== undefined && !setups.some((s) => s.id === setupId)) {
        return { status: 'not-found', reason: 'unknown-setup' }
      }
      const anchor = pickAnchor(setups)
      const targets = setups.filter(
        (s) => s.id !== anchor?.id && (setupId === undefined || s.id === setupId)
      )
      // Read lazily and once per call: arms that never reach the anchor's history spend no git.
      const readAnchor = anchor
        ? lazyAnchorRead(anchor)
        : () => Promise.reject(new Error('no anchor setup'))
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
