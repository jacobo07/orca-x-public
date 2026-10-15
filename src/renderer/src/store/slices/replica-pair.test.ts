import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import type {
  ReplicaPairCompareResult,
  ReplicaPairRelationsResult,
  ReplicaPairView
} from '../../../../shared/replica-pair-view'
import { createReplicaPairSlice } from './replica-pair'

const client = vi.hoisted(() => ({
  compareReplicaPairs: vi.fn(),
  readReplicaRelations: vi.fn()
}))
vi.mock('@/runtime/runtime-replica-pair-client', () => client)

const TIPS = ['b'.repeat(40), 'b'.repeat(40)] as const

function view(setupId: string, healthy: boolean): ReplicaPairView {
  return {
    setupId,
    anchorSetupId: 'a',
    hostId: 'ssh:gpu-vm',
    relation: { kind: 'same', observedTips: TIPS },
    healthy
  }
}

function makeStore(settings: unknown = null) {
  return create<AppState>()(
    (...a) => ({ settings, ...createReplicaPairSlice(...a) }) as unknown as AppState
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const ok = (...pairs: ReplicaPairView[]): ReplicaPairRelationsResult => ({ status: 'ok', pairs })

beforeEach(() => {
  vi.useFakeTimers()
  client.compareReplicaPairs.mockReset()
  client.readReplicaRelations.mockReset()
})

afterEach(() => {
  expect(vi.getTimerCount()).toBe(0)
  vi.useRealTimers()
})

describe('replicaPair slice refresh (row 62)', () => {
  it('starts idle', () => {
    expect(makeStore().getState().replicaPair).toEqual({ status: 'idle' })
  })

  it('sets loading, reads once with the active target, then holds the published relations', async () => {
    const answer = deferred<ReplicaPairRelationsResult>()
    client.readReplicaRelations.mockReturnValue(answer.promise)
    const store = makeStore()

    const pending = store.getState().refreshReplicaPairRelations()
    expect(store.getState().replicaPair).toEqual({ status: 'loading' })
    answer.resolve(ok(view('b', true)))
    await pending

    expect(client.readReplicaRelations).toHaveBeenCalledTimes(1)
    expect(client.readReplicaRelations).toHaveBeenCalledWith({ kind: 'local' })
    const state = store.getState().replicaPair
    expect(state.status).toBe('ready')
    if (state.status === 'ready') {
      expect(state.views).toEqual([view('b', true)])
    }
  })

  it('passes an environment target when a remote runtime is active', async () => {
    client.readReplicaRelations.mockResolvedValue({ status: 'refused', reason: 'remote-caller' })
    const store = makeStore({ activeRuntimeEnvironmentId: 'env-1' })

    await store.getState().refreshReplicaPairRelations()

    expect(client.readReplicaRelations).toHaveBeenCalledWith({
      kind: 'environment',
      environmentId: 'env-1'
    })
  })

  // Parity table (copied from 02-03 project-root-identity-client-projection.test.ts).
  it('publishes equal tips with a worktree not verified clean as unknown, never same', async () => {
    client.readReplicaRelations.mockResolvedValue(ok(view('b', false)))
    const store = makeStore()

    await store.getState().refreshReplicaPairRelations()

    const state = store.getState().replicaPair
    expect(state.status === 'ready' && state.relations.get('b')).toEqual({
      kind: 'unknown',
      reason: 'worktree-not-verified-clean'
    })
  })

  it('publishes equal tips with both worktrees clean as same (control)', async () => {
    client.readReplicaRelations.mockResolvedValue(ok(view('b', true)))
    const store = makeStore()

    await store.getState().refreshReplicaPairRelations()

    const state = store.getState().replicaPair
    expect(state.status === 'ready' && state.relations.get('b')).toEqual({
      kind: 'same',
      observedTips: TIPS
    })
  })

  it('keeps the relations reference stable until the next answer', async () => {
    client.readReplicaRelations.mockResolvedValue(ok(view('b', true)))
    const store = makeStore()
    await store.getState().refreshReplicaPairRelations()
    const first = store.getState().replicaPair
    store.setState({ settings: null } as Partial<AppState>)
    const second = store.getState().replicaPair

    expect(second).toBe(first)
    await store.getState().refreshReplicaPairRelations()
    const third = store.getState().replicaPair
    expect(third.status === 'ready' && first.status === 'ready' && third.relations).not.toBe(
      first.status === 'ready' && first.relations
    )
  })

  it.each([
    [{ status: 'refused', reason: 'remote-caller' }, 'remote-caller'],
    [{ status: 'unavailable', reason: 'no-replica-service' }, 'no-replica-service']
  ] as const)('maps %o to unavailable with an empty relations view', async (answer, reason) => {
    client.readReplicaRelations.mockResolvedValue(answer)
    const store = makeStore()

    await store.getState().refreshReplicaPairRelations()

    expect(store.getState().replicaPair).toEqual({ status: 'unavailable', reason })
  })

  it('maps a rejected promise to failed, drops earlier relations, and recovers on a good answer', async () => {
    client.readReplicaRelations.mockResolvedValueOnce(ok(view('b', true)))
    const store = makeStore()
    await store.getState().refreshReplicaPairRelations()
    expect(store.getState().replicaPair.status).toBe('ready')

    client.readReplicaRelations.mockRejectedValueOnce(new Error('ipc closed'))
    await store.getState().refreshReplicaPairRelations()
    expect(store.getState().replicaPair).toEqual({
      status: 'failed',
      reason: 'transport',
      message: 'ipc closed'
    })

    client.readReplicaRelations.mockResolvedValueOnce(ok(view('b', true)))
    await store.getState().refreshReplicaPairRelations()
    expect(store.getState().replicaPair.status).toBe('ready')
  })

  it('does not read a rejected promise as an empty ready list', async () => {
    client.readReplicaRelations.mockRejectedValue(new Error('boom'))
    const store = makeStore()

    await store.getState().refreshReplicaPairRelations()

    expect(store.getState().replicaPair.status).toBe('failed')
  })

  it('drops a stale answer that resolves after a newer request was issued', async () => {
    const older = deferred<ReplicaPairRelationsResult>()
    const newer = deferred<ReplicaPairRelationsResult>()
    client.readReplicaRelations
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise)
    const store = makeStore()

    const first = store.getState().refreshReplicaPairRelations()
    const second = store.getState().refreshReplicaPairRelations()
    newer.resolve(ok(view('new', true)))
    await second
    older.resolve(ok(view('old', true)))
    await first

    const state = store.getState().replicaPair
    expect(state.status === 'ready' && state.views.map((v) => v.setupId)).toEqual(['new'])
  })

  it('applies sequential refreshes in order (control)', async () => {
    client.readReplicaRelations
      .mockResolvedValueOnce(ok(view('one', true)))
      .mockResolvedValueOnce(ok(view('two', true)))
    const store = makeStore()

    await store.getState().refreshReplicaPairRelations()
    let state = store.getState().replicaPair
    expect(state.status === 'ready' && state.views[0]?.setupId).toBe('one')
    await store.getState().refreshReplicaPairRelations()
    state = store.getState().replicaPair
    expect(state.status === 'ready' && state.views[0]?.setupId).toBe('two')
  })
})

describe('replicaPair slice compareReplicaPairsForProject (row 62)', () => {
  it('compares once with the ids and merges the result into ready by setupId', async () => {
    client.readReplicaRelations.mockResolvedValue(ok(view('b', false), view('c', true)))
    const store = makeStore()
    await store.getState().refreshReplicaPairRelations()

    const compared: ReplicaPairCompareResult = { status: 'ok', pairs: [view('b', true)] }
    client.compareReplicaPairs.mockResolvedValue(compared)
    await store.getState().compareReplicaPairsForProject('p1', 'b')

    expect(client.compareReplicaPairs).toHaveBeenCalledTimes(1)
    expect(client.compareReplicaPairs).toHaveBeenCalledWith({ kind: 'local' }, 'p1', 'b')
    const state = store.getState().replicaPair
    expect(state.status).toBe('ready')
    if (state.status === 'ready') {
      expect(state.views).toEqual([view('b', true), view('c', true)])
      expect(state.relations.get('b')).toMatchObject({ kind: 'same' })
      expect(state.relations.get('c')).toMatchObject({ kind: 'same' })
    }
  })

  it('rebuilds relations from the merged views through the publication rule', async () => {
    client.readReplicaRelations.mockResolvedValue(ok(view('b', true)))
    const store = makeStore()
    await store.getState().refreshReplicaPairRelations()

    client.compareReplicaPairs.mockResolvedValue({ status: 'ok', pairs: [view('b', false)] })
    await store.getState().compareReplicaPairsForProject('p1')

    const state = store.getState().replicaPair
    expect(state.status === 'ready' && state.relations.get('b')).toEqual({
      kind: 'unknown',
      reason: 'worktree-not-verified-clean'
    })
    expect(client.compareReplicaPairs).toHaveBeenCalledWith({ kind: 'local' }, 'p1', undefined)
  })

  it.each([['unknown-project' as const], ['unknown-setup' as const]])(
    'maps not-found %s to failed with that reason',
    async (reason) => {
      client.compareReplicaPairs.mockResolvedValue({ status: 'not-found', reason })
      const store = makeStore()

      await store.getState().compareReplicaPairsForProject('p1', 's')

      expect(store.getState().replicaPair).toEqual({ status: 'failed', reason })
    }
  )

  it('maps refused to unavailable and a rejection to failed', async () => {
    const store = makeStore()
    client.compareReplicaPairs.mockResolvedValueOnce({ status: 'refused', reason: 'remote-caller' })
    await store.getState().compareReplicaPairsForProject('p1')
    expect(store.getState().replicaPair).toEqual({ status: 'unavailable', reason: 'remote-caller' })

    client.compareReplicaPairs.mockRejectedValueOnce(new Error('relay gone'))
    await store.getState().compareReplicaPairsForProject('p1')
    expect(store.getState().replicaPair).toEqual({
      status: 'failed',
      reason: 'transport',
      message: 'relay gone'
    })
  })

  it('drops a compare answer that a newer refresh overtook', async () => {
    const compare = deferred<ReplicaPairCompareResult>()
    client.compareReplicaPairs.mockReturnValue(compare.promise)
    client.readReplicaRelations.mockResolvedValue(ok(view('fresh', true)))
    const store = makeStore()

    const pending = store.getState().compareReplicaPairsForProject('p1')
    await store.getState().refreshReplicaPairRelations()
    compare.resolve({ status: 'ok', pairs: [view('stale', true)] })
    await pending

    const state = store.getState().replicaPair
    expect(state.status === 'ready' && state.views.map((v) => v.setupId)).toEqual(['fresh'])
  })
})
