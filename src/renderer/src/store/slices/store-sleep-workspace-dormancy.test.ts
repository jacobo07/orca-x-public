import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import {
  createTestStore,
  makeRuntimeOwnedWorktree,
  makeTab,
  makeWorktree,
  seedStore
} from './store-test-helpers'
import { shutdownBufferCaptures } from '@/components/terminal-pane/shutdown-buffer-captures'
import { decideTerminalTabMount } from '@/components/terminal/background-terminal-worktree-mount'
import { terminalTabSchema } from '../../../../shared/workspace-session-terminal-tab-schema'
import { getDefaultSettings } from '../../../../shared/constants'
import { createCompatibleRuntimeStatusResponseIfNeeded } from '../../runtime/runtime-compatibility-test-fixture'
import {
  applySleepRuntimeRpcDefault,
  createStoreCascadesMockApi
} from './store-cascades-test-harness'

const mockUnregisterPtyDataHandlers = vi.hoisted(() => vi.fn<() => unknown[]>(() => []))

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: mockUnregisterPtyDataHandlers
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

const mockApi = createStoreCascadesMockApi()
const WT = 'repo1::/path/wt1'
const OTHER_WT = 'repo1::/path/wt2'

function seedTwoTabWorkspace(store: ReturnType<typeof createTestStore>): void {
  seedStore(store, {
    worktreesByRepo: {
      repo1: [
        makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' }),
        makeWorktree({ id: OTHER_WT, repoId: 'repo1', path: '/path/wt2' })
      ]
    },
    tabsByWorktree: {
      [WT]: [
        makeTab({ id: 'agent-tab', worktreeId: WT, title: 'Codex' }),
        makeTab({ id: 'shell-tab', worktreeId: WT, title: 'Terminal' })
      ],
      [OTHER_WT]: [makeTab({ id: 'other-tab', worktreeId: OTHER_WT })]
    },
    ptyIdsByTabId: { 'agent-tab': ['pty-1'], 'shell-tab': ['pty-2'], 'other-tab': ['pty-3'] }
  })
}

function seedRuntimeWorkspace(store: ReturnType<typeof createTestStore>): void {
  seedStore(store, {
    settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'runtime-1' },
    worktreesByRepo: {
      repo1: [makeRuntimeOwnedWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })]
    },
    tabsByWorktree: { [WT]: [makeTab({ id: 'remote-tab', worktreeId: WT })] },
    ptyIdsByTabId: { 'remote-tab': ['remote:runtime-1@@pty-1'] }
  })
}

function tab(store: ReturnType<typeof createTestStore>, worktreeId: string, tabId: string) {
  const found = store.getState().tabsByWorktree[worktreeId]?.find((t) => t.id === tabId)
  if (!found) {
    throw new Error(`tab ${tabId} missing`)
  }
  return found
}

// Why: a manual workspace sleep that forgets dormancy is undone by the next activation, which
// mounts every slept tab and resumes it.
describe('shutdownWorktreeTerminals (manual sleep) — positive dormancy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearRuntimeCompatibilityCacheForTests()
    mockApi.pty.kill.mockResolvedValue(undefined)
    mockUnregisterPtyDataHandlers.mockReturnValue([])
    applySleepRuntimeRpcDefault(mockApi)
    shutdownBufferCaptures.clear()
  })

  it('marks every slept tab dormant, so activation leaves them unmounted', async () => {
    const store = createTestStore()
    seedTwoTabWorkspace(store)

    await store.getState().shutdownWorktreeTerminals(WT, { keepIdentifiers: true })

    for (const tabId of ['agent-tab', 'shell-tab']) {
      const slept = tab(store, WT, tabId)
      expect(slept.dormancy).toEqual({ reason: 'workspace-sleep' })
      expect(decideTerminalTabMount(null, slept)).toBe('dormant')
    }
    expect(tab(store, OTHER_WT, 'other-tab').dormancy).toBeUndefined()
  })

  it('does not mark anything when every stop fails and the shutdown rolls back', async () => {
    const store = createTestStore()
    seedTwoTabWorkspace(store)
    mockApi.pty.kill.mockRejectedValue(new Error('physical stop failed'))

    await expect(
      store.getState().shutdownWorktreeTerminals(WT, { keepIdentifiers: true })
    ).rejects.toThrow('physical stop failed')

    expect(store.getState().ptyIdsByTabId['agent-tab']).toEqual(['pty-1'])
    expect(tab(store, WT, 'agent-tab').dormancy).toBeUndefined()
    expect(tab(store, WT, 'shell-tab').dormancy).toBeUndefined()
  })

  // Why: a partly failed sleep keeps the workspace open for a retry; the flow re-activates it.
  it('does not mark anything when the sleep only partly stops', async () => {
    const store = createTestStore()
    seedTwoTabWorkspace(store)
    mockApi.pty.kill.mockRejectedValueOnce(new Error('physical stop failed'))

    await expect(
      store.getState().shutdownWorktreeTerminals(WT, { keepIdentifiers: true })
    ).rejects.toThrow('physical stop failed')

    expect(tab(store, WT, 'agent-tab').dormancy).toBeUndefined()
    expect(tab(store, WT, 'shell-tab').dormancy).toBeUndefined()
  })

  it('marks a runtime-hosted workspace once its owner confirms the sleep', async () => {
    const store = createTestStore()
    seedRuntimeWorkspace(store)

    await store.getState().shutdownWorktreeTerminals(WT, { keepIdentifiers: true })

    expect(tab(store, WT, 'remote-tab').dormancy).toEqual({ reason: 'workspace-sleep' })
  })

  it('does not mark a runtime-hosted workspace when its owner refuses and the stop rolls back', async () => {
    const store = createTestStore()
    mockApi.runtimeEnvironments.call.mockImplementation((args: { method: string }) => {
      const compatible = createCompatibleRuntimeStatusResponseIfNeeded(args)
      if (compatible) {
        return Promise.resolve(compatible)
      }
      return args.method === 'terminal.sleep'
        ? Promise.reject(new Error('runtime graph unavailable'))
        : Promise.resolve({ id: 'rpc', ok: true, result: {}, _meta: { runtimeId: 'remote' } })
    })
    seedRuntimeWorkspace(store)

    await expect(
      store.getState().shutdownWorktreeTerminals(WT, { keepIdentifiers: true })
    ).rejects.toThrow('runtime graph unavailable')

    expect(store.getState().ptyIdsByTabId['remote-tab']).toEqual(['remote:runtime-1@@pty-1'])
    expect(tab(store, WT, 'remote-tab').dormancy).toBeUndefined()
  })

  it('does not mark tabs for a shutdown that is not a manual sleep', async () => {
    const store = createTestStore()
    seedTwoTabWorkspace(store)

    await store.getState().shutdownWorktreeTerminals(WT, {
      keepIdentifiers: true,
      shutdownReason: 'auto-hibernate-completed-agent',
      sleepingPaneKeys: []
    })

    expect(tab(store, WT, 'agent-tab').dormancy).toBeUndefined()
  })

  it('keeps the marker through a persisted round trip and ends it only when a PTY binds', async () => {
    const store = createTestStore()
    seedTwoTabWorkspace(store)
    await store.getState().shutdownWorktreeTerminals(WT, { keepIdentifiers: true })

    const parsed = terminalTabSchema.parse(tab(store, WT, 'shell-tab'))
    expect(parsed.dormancy).toEqual({ reason: 'workspace-sleep' })

    expect(store.getState().requestDormantTerminalTabOpen('shell-tab')).toBe(true)
    expect(tab(store, WT, 'shell-tab').dormancy).toEqual({ reason: 'workspace-sleep' })
    store.getState().updateTabPtyId('shell-tab', 'pty-9')
    expect(tab(store, WT, 'shell-tab').dormancy).toBeUndefined()
  })
})
