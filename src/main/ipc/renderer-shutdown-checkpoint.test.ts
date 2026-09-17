import { beforeEach, describe, expect, it, vi } from 'vitest'

// An IpcMainEvent always carries its sender, and the handler derives the window write scope from it.
type ShutdownEvent = { sender: { id: number }; returnValue?: unknown }

function makeEvent(): ShutdownEvent {
  return { sender: { id: 1 } }
}

const { syncHandlers, invokeHandlers } = vi.hoisted(() => ({
  syncHandlers: new Map<
    string,
    (event: { sender: { id: number }; returnValue?: unknown }, args: Record<string, unknown>) => void
  >(),
  invokeHandlers: new Map<string, () => Promise<{ ok: boolean }>>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    on: vi.fn(
      (
        channel: string,
        handler: (
          event: { sender: { id: number }; returnValue?: unknown },
          args: Record<string, unknown>
        ) => void
      ) => {
        syncHandlers.set(channel, handler)
      }
    ),
    handle: vi.fn((channel: string, handler: () => Promise<{ ok: boolean }>) => {
      invokeHandlers.set(channel, handler)
    })
  }
}))

import {
  registerRendererShutdownCheckpointHandler,
  SHUTDOWN_CHECKPOINT_FLUSH_DEADLINE_MS
} from './renderer-shutdown-checkpoint'

const AWAIT_CHANNEL = 'app:await-before-unload-checkpoint'

describe('registerRendererShutdownCheckpointHandler', () => {
  beforeEach(() => {
    syncHandlers.clear()
    invokeHandlers.clear()
    vi.restoreAllMocks()
  })

  it('stages every shutdown mutation before queueing persistence', () => {
    const callOrder: string[] = []
    const store = {
      stageWorkspaceSessionBeforeUnload: vi.fn((_state, hostId?: string) => {
        callOrder.push(`session:${hostId ?? 'local'}`)
      }),
      updateUI: vi.fn(() => callOrder.push('ui')),
      flushPendingOrThrowAsync: vi.fn(() => {
        callOrder.push('persist')
        return Promise.resolve()
      })
    }
    registerRendererShutdownCheckpointHandler(store as never)

    const handler = syncHandlers.get('app:stage-before-unload-sync')
    expect(handler).toBeDefined()
    const event = makeEvent()
    const localSession = { activeWorktreeId: 'local-worktree' }
    const remoteSession = { activeWorktreeId: 'remote-worktree' }
    handler?.(event, {
      sessions: [{ state: localSession }, { state: remoteSession, hostId: 'runtime:host-1' }],
      ui: { activeView: 'settings' }
    })

    // The empty scope is what one window means: it speaks for every project it has visited.
    // Scoping across windows is pinned in shutdown-checkpoint-window-scope.test.ts.
    expect(store.stageWorkspaceSessionBeforeUnload).toHaveBeenNthCalledWith(
      1,
      localSession,
      undefined,
      {}
    )
    expect(store.stageWorkspaceSessionBeforeUnload).toHaveBeenNthCalledWith(
      2,
      remoteSession,
      'runtime:host-1',
      {}
    )
    expect(store.updateUI).toHaveBeenCalledWith({ activeView: 'settings' })
    expect(store.flushPendingOrThrowAsync).toHaveBeenCalledTimes(1)
    // Why: Store fences the staged generation without draining unrelated live mutations.
    expect(store.flushPendingOrThrowAsync).toHaveBeenCalledWith(
      expect.objectContaining({ drainToStableGeneration: false })
    )
    expect(callOrder).toEqual(['session:local', 'session:runtime:host-1', 'ui', 'persist'])
    expect(event.returnValue).toEqual({ ok: true })
  })

  it('reports a staging failure so the renderer can retry', () => {
    const store = {
      stageWorkspaceSessionBeforeUnload: vi.fn(),
      updateUI: vi.fn(() => {
        throw new Error('disk full')
      }),
      flushPendingOrThrowAsync: vi.fn(() => Promise.resolve())
    }
    registerRendererShutdownCheckpointHandler(store as never)

    const handler = syncHandlers.get('app:stage-before-unload-sync')
    const event = makeEvent()
    handler?.(event, { sessions: [], ui: { activeView: 'settings' } })

    expect(event.returnValue).toEqual({ ok: false })
  })

  it('does not queue persistence when staging is incomplete', async () => {
    const store = {
      stageWorkspaceSessionBeforeUnload: vi.fn(),
      updateUI: vi.fn(),
      flushPendingOrThrowAsync: vi.fn(() => Promise.resolve())
    }
    registerRendererShutdownCheckpointHandler(store as never)

    store.updateUI.mockImplementation(() => {
      throw new Error('invalid state')
    })
    const handler = syncHandlers.get('app:stage-before-unload-sync')
    const event = makeEvent()
    handler?.(event, { sessions: [], ui: { activeView: 'settings' } })

    expect(store.flushPendingOrThrowAsync).not.toHaveBeenCalled()
    expect(event.returnValue).toEqual({ ok: false })
    await expect(invokeHandlers.get(AWAIT_CHANNEL)?.()).resolves.toEqual({ ok: false })
  })

  it('stages synchronously without waiting on the durable write', () => {
    const store = {
      stageWorkspaceSessionBeforeUnload: vi.fn(),
      updateUI: vi.fn(),
      flushPendingOrThrowAsync: vi.fn(() => new Promise<void>(() => {}))
    }
    registerRendererShutdownCheckpointHandler(store as never)

    const handler = syncHandlers.get('app:stage-before-unload-sync')
    const event = makeEvent()
    handler?.(event, { sessions: [], ui: { activeView: 'settings' } })

    expect(event.returnValue).toEqual({ ok: true })
  })

  it('holds the checkpoint open until the durable write settles', async () => {
    let resolveFlush!: () => void
    const store = {
      stageWorkspaceSessionBeforeUnload: vi.fn(),
      updateUI: vi.fn(),
      flushPendingOrThrowAsync: vi.fn(
        () =>
          new Promise<void>((next) => {
            resolveFlush = next
          })
      )
    }
    registerRendererShutdownCheckpointHandler(store as never)

    syncHandlers.get('app:stage-before-unload-sync')?.(makeEvent(), { sessions: [], ui: {} })
    const checkpoint = invokeHandlers.get(AWAIT_CHANNEL)?.()
    let settled: unknown = 'pending'
    void checkpoint?.then((result) => {
      settled = result
    })

    await Promise.resolve()
    expect(settled).toBe('pending')

    resolveFlush()
    await expect(checkpoint).resolves.toEqual({ ok: true })
  })

  it('reports a failed durable write instead of a successful checkpoint', async () => {
    const store = {
      stageWorkspaceSessionBeforeUnload: vi.fn(),
      updateUI: vi.fn(),
      flushPendingOrThrowAsync: vi.fn(() => Promise.reject(new Error('disk full')))
    }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    registerRendererShutdownCheckpointHandler(store as never)

    const event = makeEvent()
    syncHandlers.get('app:stage-before-unload-sync')?.(event, { sessions: [], ui: {} })

    expect(event.returnValue).toEqual({ ok: true })
    await expect(invokeHandlers.get(AWAIT_CHANNEL)?.()).resolves.toEqual({ ok: false })
  })

  it('fails the checkpoint when the durable write outlives its deadline', async () => {
    const store = {
      stageWorkspaceSessionBeforeUnload: vi.fn(),
      updateUI: vi.fn(),
      flushPendingOrThrowAsync: vi.fn(
        (_options: { signal: AbortSignal }) => new Promise<void>(() => {})
      )
    }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.useFakeTimers()
    try {
      registerRendererShutdownCheckpointHandler(store as never)
      syncHandlers.get('app:stage-before-unload-sync')?.(makeEvent(), { sessions: [], ui: {} })
      const checkpoint = invokeHandlers.get(AWAIT_CHANNEL)?.()

      await vi.advanceTimersByTimeAsync(SHUTDOWN_CHECKPOINT_FLUSH_DEADLINE_MS)

      await expect(checkpoint).resolves.toEqual({ ok: false })
      expect(store.flushPendingOrThrowAsync.mock.calls[0]?.[0]?.signal.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports success before any checkpoint is staged', async () => {
    const store = {
      stageWorkspaceSessionBeforeUnload: vi.fn(),
      updateUI: vi.fn(),
      flushPendingOrThrowAsync: vi.fn(() => Promise.resolve())
    }
    registerRendererShutdownCheckpointHandler(store as never)

    await expect(invokeHandlers.get(AWAIT_CHANNEL)?.()).resolves.toEqual({ ok: true })
  })
})
