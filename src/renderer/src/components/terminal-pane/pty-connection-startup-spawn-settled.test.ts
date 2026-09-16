import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from './pty-connection-test-async'
import { createMockTransport, createPane, createManager } from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import type { MockTransport } from './pty-connection-test-pane-fixtures'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

// The per-pane resume respawns a pane with a startup and needs to know how that spawn ended.

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []
let createdTransportOptions: Record<string, unknown>[] = []

vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))
vi.mock('./terminal-webgl-atlas-recovery', () => ({ scheduleTerminalWebglAtlasRecovery: vi.fn() }))
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
vi.mock('./cache-timer-seeding', () => ({ shouldSeedCacheTimerOnInitialTitle: vi.fn(() => false) }))
vi.mock('sonner', () => ({ toast: { info: vi.fn() } }))
vi.mock('@/lib/codex-stale-pane-sweep', () => ({ notifyCodexPaneBoundForStaleSweep: vi.fn() }))
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return {
    ...actual,
    useCallback: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn
  }
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

const eagerBufferPtyIds = new Set<string>()
vi.mock('./pty-dispatcher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    getEagerPtyBufferHandle: vi.fn((ptyId: string) =>
      eagerBufferPtyIds.has(ptyId) ? { flush: () => '', dispose: () => {} } : undefined
    )
  }
})

const SESSION = { key: 'session_id' as const, id: 'session-s' }
const STARTUP = {
  command: "claude '--resume' 'session-s'",
  env: { ORCA_AGENT_LAUNCH_TOKEN: 'token-1' },
  launchConfig: { agentArgs: '', agentEnv: {} },
  resumeProviderSession: SESSION,
  launchToken: 'token-1',
  launchAgent: 'claude' as const
}

async function connectWithStartup(
  transport: MockTransport,
  withCallback = true,
  expectConnect = true
) {
  const { connectPanePty } = await import('./pty-connection')
  transportFactoryQueue.push(transport)
  const onStartupSpawnSettled = vi.fn()
  connectPanePty(
    createPane(1) as never,
    createManager(1) as never,
    buildPaneConnectionDeps(() => mockStoreState, {
      startup: STARTUP,
      ...(withCallback ? { onStartupSpawnSettled } : {})
    }) as never
  )
  await flushAsyncTicks(20)
  if (expectConnect) {
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalled())
  }
  if (withCallback) {
    // Why: the report follows the whole spawn settlement, which awaits several IPC mocks.
    await vi.waitFor(() => expect(onStartupSpawnSettled).toHaveBeenCalled(), { timeout: 3000 })
  }
  await flushAsyncTicks(10)
  return onStartupSpawnSettled
}

describe('connectPanePty startup spawn outcome', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    createdTransportOptions = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    // Why: an in-place respawn clears the tab's PTY first, so the pane spawns fresh.
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
      ptyIdsByTabId: {}
    } as StoreState
    installTerminalTestGlobals()
  })
  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  it('carries the session to the spawn and reports the new PTY once', async () => {
    const transport = createMockTransport()
    transport.connect.mockImplementation(async () => ({ id: 'fresh-pty' }))

    const report = await connectWithStartup(transport)

    expect(createdTransportOptions[0]).toMatchObject({ resumeProviderSession: SESSION })
    expect(report).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledWith({ kind: 'spawned', ptyId: 'fresh-pty', reattached: false })
  })

  it('reports a resume main refused', async () => {
    const transport = createMockTransport()
    transport.connect.mockImplementation(async () => ({
      id: 'fresh-pty',
      agentResumeRefused: 'live-elsewhere'
    }))

    const report = await connectWithStartup(transport)

    expect(report).toHaveBeenCalledWith({
      kind: 'spawned',
      ptyId: 'fresh-pty',
      reattached: false,
      agentResumeRefused: 'live-elsewhere'
    })
  })

  it('reports a failed spawn', async () => {
    const transport = createMockTransport()
    transport.connect.mockImplementation(async () => {
      throw new Error('spawn failed')
    })

    const report = await connectWithStartup(transport)

    expect(report).toHaveBeenCalledWith({ kind: 'failed' })
  })

  it('says the startup did not run when the pane adopts an existing PTY', async () => {
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'old-shell' }] }
    } as StoreState
    const transport = createMockTransport()

    const report = await connectWithStartup(transport)

    expect(report).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledWith({ kind: 'spawned', ptyId: 'old-shell', reattached: true })
  })

  it('says the startup did not run when the pane attaches a live detached PTY', async () => {
    eagerBufferPtyIds.add('live-shell')
    try {
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'live-shell' }] },
        ptyIdsByTabId: { 'tab-1': ['live-shell'] }
      } as StoreState
      const transport = createMockTransport()

      const report = await connectWithStartup(transport, true, false)

      expect(transport.attach).toHaveBeenCalled()
      expect(report).toHaveBeenCalledWith({
        kind: 'spawned',
        ptyId: 'live-shell',
        reattached: true
      })
    } finally {
      eagerBufferPtyIds.clear()
    }
  })

  it('spawns normally when nobody asked for the outcome', async () => {
    const transport = createMockTransport()
    transport.connect.mockImplementation(async () => ({ id: 'fresh-pty' }))

    await connectWithStartup(transport, false)

    expect(transport.connect).toHaveBeenCalledTimes(1)
  })
})
