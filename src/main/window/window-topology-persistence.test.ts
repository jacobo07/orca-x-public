/**
 * The store side of window topology: what actually reaches disk, and what must not.
 *
 * The model already refuses to publish an empty capture; this is where that refusal has to survive
 * contact with a real quit and a real failed read. The case worth the most here is the last one — a
 * read that throws must not leave the caller holding a value it will publish back.
 */
import { describe, expect, it, vi } from 'vitest'
import type { PersistedWindowTopologyEntry } from './window-topology'
import {
  publishWindowTopology,
  readWindowTopologyRestorePlan,
  type WindowTopologyStore
} from './window-topology-persistence'

const BOUNDS = { x: 10, y: 20, width: 1200, height: 800 }

function liveWindow(overrides: Partial<PersistedWindowTopologyEntry> = {}) {
  return {
    windowId: 'window-1',
    sequence: 1,
    binding: { repoId: 'repo-1', worktreeId: 'repo-1::/tmp/a' },
    bounds: BOUNDS,
    maximized: false,
    ...overrides
  }
}

function makeStore(ui: Record<string, unknown> = {}) {
  const updateUI = vi.fn<(patch: { windowTopology: PersistedWindowTopologyEntry[] }) => void>()
  return { getUI: () => ui, updateUI } satisfies WindowTopologyStore
}

describe('publishWindowTopology', () => {
  it('writes the live window set', () => {
    const store = makeStore()

    const published = publishWindowTopology({
      store,
      listLiveWindows: () => [liveWindow()],
      isQuitting: () => false
    })

    expect(published?.map((entry) => entry.windowId)).toEqual(['window-1'])
    expect(store.updateUI).toHaveBeenCalledWith({ windowTopology: published })
  })

  it('writes nothing while quitting, so the last close cannot erase the set', () => {
    const store = makeStore()

    const published = publishWindowTopology({
      store,
      listLiveWindows: () => [liveWindow()],
      isQuitting: () => true
    })

    expect(published).toBeNull()
    expect(store.updateUI).not.toHaveBeenCalled()
  })

  it('writes nothing when no window is live', () => {
    const store = makeStore()

    publishWindowTopology({ store, listLiveWindows: () => [], isQuitting: () => false })

    expect(store.updateUI).not.toHaveBeenCalled()
  })
})

describe('readWindowTopologyRestorePlan', () => {
  it('plans the recorded windows', () => {
    const store = makeStore({
      windowTopology: [liveWindow(), liveWindow({ windowId: 'window-2', sequence: 2, binding: null })]
    })

    const plan = readWindowTopologyRestorePlan({ store, worktreeExists: () => true })

    expect(plan?.map((entry) => entry.windowId)).toEqual(['window-1', 'window-2'])
  })

  it('reports no plan when nothing was recorded', () => {
    expect(readWindowTopologyRestorePlan({ store: makeStore(), worktreeExists: () => true })).toBeNull()
  })

  it('reports no plan when the recorded value is unusable', () => {
    const store = makeStore({ windowTopology: { windows: 'gone' } })

    expect(readWindowTopologyRestorePlan({ store, worktreeExists: () => true })).toBeNull()
  })

  it('reports no plan when the read itself fails, rather than an empty one', () => {
    // An empty plan and a failed read differ: the first is a fact about the user's windows, the
    // second is a fact about this process. Only the first may ever reach a publish.
    const store: WindowTopologyStore = {
      getUI: () => {
        throw new Error('profile unreadable')
      },
      updateUI: vi.fn()
    }

    expect(readWindowTopologyRestorePlan({ store, worktreeExists: () => true })).toBeNull()
  })
})
