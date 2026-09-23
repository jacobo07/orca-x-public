import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

// Phase 6: an unsent line lives in one shell. A fresh process cannot hold the dead one's draft,
// while a reattach or a handle rotation is the same shell and must keep it.

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []
let createdTransportOptions: Record<string, unknown>[] = []

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockStoreState,
    subscribe: () => () => {}
  }
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const { buildAgentStatusModuleMock } = await import('./pty-connection-test-environment')
  return buildAgentStatusModuleMock(await importOriginal<Record<string, unknown>>())
})

vi.mock('./pty-transport', () => ({
  createIpcPtyTransport: vi.fn((options: Record<string, unknown>) => {
    createdTransportOptions.push(options)
    const next = transportFactoryQueue.shift()
    if (!next) {
      throw new Error('No mock transport queued')
    }
    return next
  })
}))

const PANE_KEY = makePaneKey('tab-1', LEAF_1)

function transportOption<T>(name: string): T {
  return createdTransportOptions[0]?.[name] as T
}

// Why above the waits' 150s bound: the config's 30s test timeout would otherwise fire first, so a
// starved host reads as a failure instead of reaching the condition.
describe('unsent-input evidence belongs to one shell incarnation', { timeout: 180_000 }, () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    createdTransportOptions = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    installTerminalTestGlobals()
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  it('drops the previous shell draft when a fresh shell is spawned into the pane', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transport.connect.mockImplementation(async () => {
      transportOption<(ptyId: string) => void>('onPtySpawn')('fresh-pty')
      return 'fresh-pty'
    })
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      ptyIdsByTabId: { 'tab-1': [] }
    } as StoreState

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      buildPaneConnectionDeps(() => mockStoreState) as never
    )
    await flushAsyncTicks()

    // Why both halves: the draft flag AND Sleep's typing stamp described the dead shell. A stale
    // stamp alone makes Sleep skip the host's draft check for the new shell.
    // Why waitFor: on a loaded host the spawn lands after a fixed flush, then leaks into the next case.
    await vi.waitFor(
      () => expect(mockStoreState.resetTerminalInputForFreshShell).toHaveBeenCalledWith(PANE_KEY),
      { timeout: 150_000, interval: 50 }
    )
    // A new shell is not a provider event: nothing here may write the explicit-exit record.
    expect(mockStoreState.markSleepingAgentExited).not.toHaveBeenCalled()
  })

  it('keeps the draft when the pane reattaches to its still-live shell', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) =>
      sessionId ? { id: sessionId } : null
    )
    transportFactoryQueue.push(transport)
    const deps = buildPaneConnectionDeps(() => mockStoreState, {
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'live-pty' }
    })

    connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks()

    // Precondition: the attach was attempted, so the absence below is a measurement.
    await vi.waitFor(
      () =>
        expect(transport.connect).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: 'live-pty' })
        ),
      { timeout: 150_000, interval: 50 }
    )
    await flushAsyncTicks()
    expect(mockStoreState.resetTerminalInputForFreshShell).not.toHaveBeenCalled()
  })

  it('keeps the draft across a provider handle rotation, which is the same shell', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (!sessionId) {
        return null
      }
      transportOption<(ptyId: string, replaced: string) => void>('onPtyRebind')(
        'rotated-pty',
        sessionId
      )
      return { id: 'rotated-pty' }
    })
    transportFactoryQueue.push(transport)
    const deps = buildPaneConnectionDeps(() => mockStoreState, {
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'live-pty' }
    })

    connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks()

    // Precondition: connect ran, and it invokes the rotation synchronously before returning.
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalled(), {
      timeout: 150_000,
      interval: 50
    })
    await flushAsyncTicks()
    expect(transportOption<unknown>('onPtyRebind')).toBeTypeOf('function')
    expect(mockStoreState.resetTerminalInputForFreshShell).not.toHaveBeenCalled()
  })
})
