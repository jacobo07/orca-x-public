import type * as SonnerModule from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildStoreState, type StoreLike } from './ipc-events-agent-status-store-test-fixtures'
import {
  buildWindowApi,
  stubReactSyncEffect,
  stubAuxiliaryModules
} from './ipc-events-agent-status-window-test-fixtures'

const LEAF = '11111111-1111-4111-8111-111111111111'

describe('useIpcEvents live session collision notices', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('subscribes on mount and warns for a pane this window holds', async () => {
    const warning = vi.fn()
    const unsubscribe = vi.fn()
    const listenerRef: { current: ((notice: unknown) => void) | null } = { current: null }
    const storeState: StoreLike = buildStoreState({
      workspaceSessionReady: true,
      settings: { terminalFontSize: 13, notifications: { enabled: false } },
      tabsByWorktree: { 'wt-1': [{ id: 'tab-here', ptyId: 'pty-1', worktreeId: 'wt-1' }] }
    })

    stubReactSyncEffect()
    vi.doMock('sonner', async () => {
      const actual = await vi.importActual<typeof SonnerModule>('sonner')
      return { ...actual, toast: Object.assign(vi.fn(), actual.toast, { warning }) }
    })
    vi.doMock('../store', () => ({
      useAppStore: { subscribe: vi.fn(() => () => {}), getState: () => storeState }
    }))
    stubAuxiliaryModules()
    vi.stubGlobal(
      'window',
      buildWindowApi({
        onSet: () => () => {},
        onLiveCollision: (cb) => {
          listenerRef.current = cb
          return unsubscribe
        }
      })
    )

    const { useIpcEvents } = await import('./useIpcEvents')
    useIpcEvents()
    await Promise.resolve()

    if (typeof listenerRef.current !== 'function') {
      throw new Error('Expected agentStatus.onLiveCollision listener to be registered')
    }
    listenerRef.current({
      paneKey: `tab-here:${LEAF}`,
      kind: 'live-elsewhere',
      liveElsewhere: [`tab-other:${LEAF}`]
    })

    expect(warning).toHaveBeenCalledTimes(1)
    expect(warning.mock.calls[0][0]).toBe('This session is also open in another pane')
  })
})
