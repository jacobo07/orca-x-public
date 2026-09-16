import type * as React from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import type { MockTransport } from './pty-connection-test-pane-fixtures'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

// D1: cold restore must not relaunch an agent the user exited, while an
// unblocked or quit-captured record still resumes its exact session.

const {
  resetAndRefreshAllTerminalWebglAtlases,
  scheduleTerminalWebglAtlasRecovery,
  scheduleRuntimeGraphSync,
  shouldSeedCacheTimerOnInitialTitle,
  toastInfo,
  notifyCodexPaneBoundForStaleSweep
} = vi.hoisted(() => ({
  resetAndRefreshAllTerminalWebglAtlases: vi.fn(),
  scheduleTerminalWebglAtlasRecovery: vi.fn(),
  scheduleRuntimeGraphSync: vi.fn(),
  shouldSeedCacheTimerOnInitialTitle: vi.fn(() => false),
  toastInfo: vi.fn(),
  notifyCodexPaneBoundForStaleSweep: vi.fn()
}))

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []
let storeSubscribers: ((state: StoreState) => void)[] = []

vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync }))
vi.mock('@/lib/pane-manager/pane-manager-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resetAndRefreshAllTerminalWebglAtlases
}))
vi.mock('./terminal-webgl-atlas-recovery', () => ({ scheduleTerminalWebglAtlasRecovery }))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockStoreState,
    subscribe: (listener: (state: StoreState) => void) => {
      storeSubscribers.push(listener)
      return () => {
        storeSubscribers = storeSubscribers.filter((candidate) => candidate !== listener)
      }
    }
  }
}))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const { buildAgentStatusModuleMock } = await import('./pty-connection-test-environment')
  return buildAgentStatusModuleMock(await importOriginal<Record<string, unknown>>())
})
vi.mock('./cache-timer-seeding', () => ({ shouldSeedCacheTimerOnInitialTitle }))
vi.mock('sonner', () => ({ toast: { info: toastInfo } }))
vi.mock('@/lib/codex-stale-pane-sweep', () => ({ notifyCodexPaneBoundForStaleSweep }))
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return {
    ...actual,
    useCallback: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn
  }
})
vi.mock('./pty-transport', () => ({
  createIpcPtyTransport: vi.fn(() => {
    const nextTransport = transportFactoryQueue.shift()
    if (!nextTransport) {
      throw new Error('No mock transport queued')
    }
    return nextTransport
  })
}))
vi.mock('./remote-runtime-pty-transport', () => ({
  createRemoteRuntimePtyTransport: vi.fn(() => {
    const nextTransport = transportFactoryQueue.shift()
    if (!nextTransport) {
      throw new Error('No mock transport queued')
    }
    return nextTransport
  })
}))
vi.mock('./pty-dispatcher', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getEagerPtyBufferHandle: vi.fn(() => undefined)
}))

const PANE_KEY = makePaneKey('tab-1', LEAF_1)

function exitShapedRecord(overrides: Partial<SleepingAgentSessionRecord> = {}) {
  return {
    paneKey: PANE_KEY,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'claude-session-exited' },
    // Exactly what setAgentStatus writes for a finished resumable turn.
    prompt: '',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    origin: 'live',
    ...overrides
  } satisfies SleepingAgentSessionRecord
}

async function coldRestoreWith(record: SleepingAgentSessionRecord): Promise<MockTransport> {
  const { connectPanePty } = await import('./pty-connection')
  const transport = createMockTransport('fresh-pty')
  transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) =>
    sessionId
      ? { id: 'fresh-pty', coldRestore: { scrollback: 'cold-payload', cwd: '/tmp/wt-1' } }
      : 'fresh-pty'
  )
  transportFactoryQueue.push(transport)
  mockStoreState = {
    ...mockStoreState,
    tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'lost-pty' }] },
    settings: { ...mockStoreState.settings, agentCmdOverrides: {} },
    agentStatusByPaneKey: {},
    sleepingAgentSessionsByPaneKey: { [PANE_KEY]: record }
  } as StoreState
  const deps = buildPaneConnectionDeps(() => mockStoreState, {
    restoredLeafId: LEAF_1,
    restoredPtyIdByLeafId: { [LEAF_1]: 'lost-pty' }
  })
  connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
  await flushAsyncTicks(20)
  await new Promise((resolve) => setTimeout(resolve, 70))
  return transport
}

function coldRestoreConnect(transport: MockTransport): { command?: unknown } {
  const call = transport.connect.mock.calls.find(
    (args) => (args[0] as { sessionId?: string } | undefined)?.sessionId === 'lost-pty'
  )
  // Why: "no resume command" is only evidence if the cold restore itself happened.
  if (!call) {
    throw new Error('cold restore never reconnected the lost pty')
  }
  return call[0] as { command?: unknown }
}

function connectedCommand(transport: MockTransport): unknown {
  return coldRestoreConnect(transport).command
}

describe('cold restore of a pane whose agent exited', () => {
  // Why: the first transform of pty-connection is slow on a loaded host; keep it out of the control's budget.
  beforeAll(async () => {
    await import('./pty-connection')
  }, 120_000)

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    storeSubscribers = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    installTerminalTestGlobals()
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  it('control: a quit-captured record resumes its exact session', async () => {
    const transport = await coldRestoreWith(
      exitShapedRecord({
        origin: 'quit',
        providerSession: { key: 'session_id', id: 'claude-session-quit' }
      })
    )

    expect(connectedCommand(transport)).toEqual(expect.stringContaining('claude-session-quit'))
  })

  it('control: an unblocked live record still resumes its exact session', async () => {
    const transport = await coldRestoreWith(exitShapedRecord())

    expect(connectedCommand(transport)).toEqual(expect.stringContaining('claude-session-exited'))
  })

  it('restores only the shell for a pane whose agent exited', async () => {
    const transport = await coldRestoreWith(
      exitShapedRecord({ automaticResumeBlockedBy: 'agent-exited' })
    )

    expect(connectedCommand(transport)).toBeUndefined()
    // Why: the identity stays for a deliberate resume later.
    const records = mockStoreState.sleepingAgentSessionsByPaneKey as Record<
      string,
      SleepingAgentSessionRecord | undefined
    >
    expect(records[PANE_KEY]?.providerSession).toEqual({
      key: 'session_id',
      id: 'claude-session-exited'
    })
  })
})
