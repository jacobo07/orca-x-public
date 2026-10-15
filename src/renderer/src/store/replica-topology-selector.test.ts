import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import { projectHostSetupProjectionFromRepos } from '../../../shared/project-host-setup-projection'
import type { Repo } from '../../../shared/repo-types'
import type { ReplicaPairView } from '../../../shared/replica-pair-view'
import type { ReplicaRelation } from '../../../shared/workspace-replica-state'
import { getReplicaTopologyFromState } from './replica-topology-selector'
import { createReplicaPairSlice } from './slices/replica-pair'
import type { AppState } from './types'

const client = vi.hoisted(() => ({
  compareReplicaPairs: vi.fn(),
  readReplicaRelations: vi.fn()
}))
vi.mock('@/runtime/runtime-replica-pair-client', () => client)

const ROOT = 'a'.repeat(40)
const TIPS = ['b'.repeat(40), 'b'.repeat(40)] as const

function repo(id: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/srv/${id}`,
    displayName: id,
    badgeColor: '#737373',
    addedAt: 10,
    kind: 'git',
    gitRemoteIdentity: null,
    gitRootIdentity: { rootCommit: ROOT, commonDir: `/srv/${id}/.git`, shallow: false },
    ...overrides
  }
}

const REPOS = [repo('a'), repo('b', { connectionId: 'gpu-vm' })]
const PROJECTION = projectHostSetupProjectionFromRepos(REPOS)

function view(relation: ReplicaRelation, healthy = true): ReplicaPairView {
  return { setupId: 'b', anchorSetupId: 'a', hostId: 'ssh:gpu-vm', relation, healthy }
}

// Real slice, so the relations the selector reads are the ones the slice published.
function makeStore() {
  return create<AppState>()(
    (...a) =>
      ({
        repos: REPOS,
        projects: [...PROJECTION.projects],
        projectHostSetups: [...PROJECTION.setups],
        settings: null,
        ...createReplicaPairSlice(...a)
      }) as unknown as AppState
  )
}

async function topologyOfB(views: ReplicaPairView[]) {
  const store = makeStore()
  client.readReplicaRelations.mockResolvedValue({ status: 'ok', pairs: views })
  await store.getState().refreshReplicaPairRelations()
  return getReplicaTopologyFromState(store.getState()).get('b')
}

beforeEach(() => {
  client.readReplicaRelations.mockReset()
  client.compareReplicaPairs.mockReset()
})

// Parity table: the same two literals as src/main/runtime/rpc/project-root-identity-client-projection.test.ts
// ("setups projection fed with published relations"), so both deriveReplicaTopology sites publish alike.
describe('selector parity with the projectHostSetup.list projection (row 62, D-02)', () => {
  it('equal tips with a worktree not verified clean: unverified with its closed reason, never same', async () => {
    expect(await topologyOfB([view({ kind: 'same', observedTips: TIPS }, false)])).toEqual({
      setupId: 'b',
      projectId: `git-root:${ROOT}`,
      hostId: 'ssh:gpu-vm',
      path: '/srv/b',
      provenance: 'legacy',
      membership: 'grouped',
      relation: 'unverified',
      relationUnknownReason: 'worktree-not-verified-clean'
    })
  })

  it('equal tips with both worktrees clean: same with no reason key (control)', async () => {
    expect(await topologyOfB([view({ kind: 'same', observedTips: TIPS }, true)])).toEqual({
      setupId: 'b',
      projectId: `git-root:${ROOT}`,
      hostId: 'ssh:gpu-vm',
      path: '/srv/b',
      provenance: 'legacy',
      membership: 'grouped',
      relation: 'same'
    })
  })

  it('carries ahead and behind counts; swapping the orientation swaps them', async () => {
    const ahead = await topologyOfB([view({ kind: 'ahead', count: 2, observedTips: TIPS })])
    expect(ahead).toMatchObject({ relation: 'ahead', relationAhead: 2 })
    expect(ahead).not.toHaveProperty('relationBehind')

    const behind = await topologyOfB([view({ kind: 'behind', count: 2, observedTips: TIPS })])
    expect(behind).toMatchObject({ relation: 'behind', relationBehind: 2 })
    expect(behind).not.toHaveProperty('relationAhead')

    const diverged = await topologyOfB([
      view({
        kind: 'diverged',
        mergeBase: 'c'.repeat(40),
        aheadCount: 3,
        behindCount: 1,
        observedTips: TIPS
      })
    ])
    const swapped = await topologyOfB([
      view({
        kind: 'diverged',
        mergeBase: 'c'.repeat(40),
        aheadCount: 1,
        behindCount: 3,
        observedTips: TIPS
      })
    ])
    expect(diverged).toMatchObject({ relation: 'diverged', relationAhead: 3, relationBehind: 1 })
    expect(swapped).toMatchObject({ relation: 'diverged', relationAhead: 1, relationBehind: 3 })
  })
})

describe('non-ready slice states feed no relations (row 62, D-02)', () => {
  const TODAYS = getReplicaTopologyFromState({
    repos: REPOS,
    projects: [...PROJECTION.projects],
    projectHostSetups: [...PROJECTION.setups]
  })

  it('state without replicaPair publishes plain unverified with no reason key (baseline)', () => {
    const entry = TODAYS.get('b')

    expect(entry).toMatchObject({ membership: 'grouped', relation: 'unverified' })
    expect(entry).not.toHaveProperty('relationUnknownReason')
  })

  it('idle is deep-equal to the state without replicaPair', () => {
    const state = makeStore().getState()

    expect(state.replicaPair.status).toBe('idle')
    expect(getReplicaTopologyFromState(state)).toEqual(
      getReplicaTopologyFromState({
        repos: REPOS,
        projects: state.projects,
        projectHostSetups: state.projectHostSetups
      })
    )
    expect(JSON.stringify([...getReplicaTopologyFromState(state)])).not.toContain(
      'relationUnknownReason'
    )
  })

  it('loading, unavailable and failed after a ready answer all drop back to the baseline', async () => {
    const store = makeStore()
    client.readReplicaRelations.mockResolvedValueOnce({
      status: 'ok',
      pairs: [view({ kind: 'ahead', count: 4, observedTips: TIPS })]
    })
    await store.getState().refreshReplicaPairRelations()
    expect(getReplicaTopologyFromState(store.getState()).get('b')).toMatchObject({
      relation: 'ahead'
    })

    let release!: (value: unknown) => void
    client.readReplicaRelations.mockReturnValueOnce(new Promise((r) => (release = r)))
    const pending = store.getState().refreshReplicaPairRelations()
    expect(store.getState().replicaPair.status).toBe('loading')
    expect(getReplicaTopologyFromState(store.getState()).get('b')).toEqual(TODAYS.get('b'))
    release({ status: 'refused', reason: 'remote-caller' })
    await pending

    expect(store.getState().replicaPair.status).toBe('unavailable')
    expect(getReplicaTopologyFromState(store.getState()).get('b')).toEqual(TODAYS.get('b'))

    client.readReplicaRelations.mockRejectedValueOnce(new Error('ipc closed'))
    await store.getState().refreshReplicaPairRelations()
    expect(store.getState().replicaPair.status).toBe('failed')
    expect(getReplicaTopologyFromState(store.getState()).get('b')).toEqual(TODAYS.get('b'))
  })
})

describe('reference stability (row 62)', () => {
  it('returns the identical Map for the same four inputs and a new one for a new relations object', async () => {
    const store = makeStore()
    client.readReplicaRelations.mockResolvedValue({
      status: 'ok',
      pairs: [view({ kind: 'same', observedTips: TIPS }, true)]
    })
    await store.getState().refreshReplicaPairRelations()
    const first = getReplicaTopologyFromState(store.getState())

    store.setState({ settings: { theme: 'dark' } } as unknown as Partial<AppState>)
    expect(getReplicaTopologyFromState(store.getState())).toBe(first)

    await store.getState().refreshReplicaPairRelations()
    const next = getReplicaTopologyFromState(store.getState())
    expect(next).not.toBe(first)
    expect(next.get('b')).toEqual(first.get('b'))
  })

  it('shares one Map across every non-ready state of the same inputs', () => {
    const base = {
      repos: REPOS,
      projects: [...PROJECTION.projects],
      projectHostSetups: [...PROJECTION.setups]
    }
    const idle = getReplicaTopologyFromState({ ...base, replicaPair: { status: 'idle' } })

    expect(getReplicaTopologyFromState({ ...base, replicaPair: { status: 'loading' } })).toBe(idle)
    expect(
      getReplicaTopologyFromState({
        ...base,
        replicaPair: { status: 'failed', reason: 'transport' }
      })
    ).toBe(idle)
  })
})
