import { projectHostSetupProjectionFromRepos } from './project-host-setup-projection'
import type { ReplicaPairView } from './replica-pair-view'
import type { ReplicaTopologyEntry } from './replica-topology'
import type { Repo } from './repo-types'
import type { ReplicaRelation } from './workspace-replica-state'

const ROOT_COMMIT = 'a'.repeat(40)
const TIP = 'b'.repeat(40)
const OBSERVED_TIPS = [TIP, TIP] as const

function repo(id: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/srv/${id}`,
    displayName: id,
    badgeColor: '#737373',
    addedAt: 10,
    kind: 'git',
    gitRemoteIdentity: null,
    gitRootIdentity: { rootCommit: ROOT_COMMIT, commonDir: `/srv/${id}/.git`, shallow: false },
    ...overrides
  }
}

// Why: `a` is the local anchor, `b` its SSH replica, `f` a folder workspace (not a git worktree).
export const CALLSITE_REPOS: readonly Repo[] = [
  repo('a'),
  repo('b', { connectionId: 'gpu-vm' }),
  repo('f', { kind: 'folder', gitRootIdentity: undefined })
]

export const CALLSITE_PROJECTION = projectHostSetupProjectionFromRepos([...CALLSITE_REPOS])

export const REPLICA_SETUP_ID = 'b'
export const ANCHOR_SETUP_ID = 'a'
export const FOLDER_SETUP_ID = 'f'

type RelationFields = Pick<
  ReplicaTopologyEntry,
  'relation' | 'relationUnknownReason' | 'relationAhead' | 'relationBehind'
>

export type RelationCallsiteCase = {
  name: string
  /** What the pair feed publishes; undefined is a call site that was never given a feed. */
  views: ReplicaPairView[] | undefined
  /** Literal truth for the replica setup, written by hand rather than derived from the producer. */
  replica: RelationFields
}

function pairView(relation: ReplicaRelation, healthy: boolean): ReplicaPairView {
  return {
    setupId: REPLICA_SETUP_ID,
    anchorSetupId: ANCHOR_SETUP_ID,
    hostId: 'ssh:gpu-vm',
    relation,
    healthy
  } as ReplicaPairView
}

export const RELATION_CALLSITE_CASES: readonly RelationCallsiteCase[] = [
  { name: 'no pair feed at all', views: undefined, replica: { relation: 'unverified' } },
  { name: 'an empty pair feed', views: [], replica: { relation: 'unverified' } },
  {
    name: 'a feed that publishes only another setup',
    views: [
      {
        ...pairView({ kind: 'ahead', count: 2, observedTips: OBSERVED_TIPS }, false),
        setupId: 'other'
      }
    ],
    replica: { relation: 'unverified' }
  },
  {
    name: 'equal tips with both worktrees clean',
    views: [pairView({ kind: 'same', observedTips: OBSERVED_TIPS }, true)],
    replica: { relation: 'same' }
  },
  {
    name: 'equal tips with a worktree not verified clean',
    views: [pairView({ kind: 'same', observedTips: OBSERVED_TIPS }, false)],
    replica: { relation: 'unverified', relationUnknownReason: 'worktree-not-verified-clean' }
  },
  {
    name: 'the anchor ahead by 2',
    views: [pairView({ kind: 'ahead', count: 2, observedTips: OBSERVED_TIPS }, false)],
    replica: { relation: 'ahead', relationAhead: 2 }
  },
  {
    name: 'the anchor behind by 1',
    views: [pairView({ kind: 'behind', count: 1, observedTips: OBSERVED_TIPS }, false)],
    replica: { relation: 'behind', relationBehind: 1 }
  },
  {
    name: 'diverged +3/-1',
    views: [
      pairView(
        {
          kind: 'diverged',
          mergeBase: 'c'.repeat(40),
          aheadCount: 3,
          behindCount: 1,
          observedTips: OBSERVED_TIPS
        },
        false
      )
    ],
    replica: { relation: 'diverged', relationAhead: 3, relationBehind: 1 }
  },
  {
    name: 'unrelated histories',
    views: [pairView({ kind: 'unrelated', observedTips: OBSERVED_TIPS }, false)],
    replica: { relation: 'unrelated' }
  },
  {
    name: 'a closed unknown reason',
    views: [pairView({ kind: 'unknown', reason: 'transfer-interrupted' }, false)],
    replica: { relation: 'unverified', relationUnknownReason: 'transfer-interrupted' }
  }
]

export function relationFieldsOf(entry: ReplicaTopologyEntry | undefined): RelationFields {
  if (!entry) {
    throw new Error('no topology entry for the setup')
  }
  const { relation, relationUnknownReason, relationAhead, relationBehind } = entry
  return {
    relation,
    ...(relationUnknownReason !== undefined ? { relationUnknownReason } : {}),
    ...(relationAhead !== undefined ? { relationAhead } : {}),
    ...(relationBehind !== undefined ? { relationBehind } : {})
  }
}
