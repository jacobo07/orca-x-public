import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { terminalTabSchema } from '../../../../shared/workspace-session-terminal-tab-schema'
import { getDefaultSettings } from '../../../../shared/constants'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { shutdownBufferCaptures } from '@/components/terminal-pane/shutdown-buffer-captures'
import type { AppState } from '../types'
import {
  createTestStore,
  makeRuntimeOwnedWorktree,
  makeTab,
  makeWorktree,
  seedStore
} from './store-test-helpers'
import {
  applySleepRuntimeRpcDefault,
  createStoreCascadesMockApi
} from './store-cascades-test-harness'

/**
 * Sleeping a workspace releases every live agent and promises it can come back. Until now the
 * marker it wrote carried no verdict, so a slept agent row could only ever say "unconfirmed" —
 * even when the conversation was sitting on disk, found. These pin that the sleep ASKS, before it
 * releases anything, and that it earns `exact` only on the same evidence a restore does.
 */

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
const NOW = 1_800_000_000_000
const TRANSCRIPT = '/home/u/.codex/sessions/2026/09/22/rollout-session-agent.jsonl'

function agentEntry(paneKey: string, tabId: string): AgentStatusEntry {
  return {
    state: 'done',
    prompt: 'finish the task',
    updatedAt: NOW,
    stateStartedAt: NOW,
    stateHistory: [],
    agentType: 'codex',
    paneKey,
    tabId,
    worktreeId: WT,
    providerSession: { key: 'session_id', id: 'session-agent', transcriptPath: TRANSCRIPT }
  }
}

function seedLocalAgentWorkspace(store: ReturnType<typeof createTestStore>): void {
  seedStore(store, {
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })] },
    tabsByWorktree: {
      [WT]: [
        makeTab({ id: 'agent-tab', worktreeId: WT, title: 'Codex' }),
        makeTab({ id: 'shell-tab', worktreeId: WT, title: 'Terminal' })
      ]
    },
    ptyIdsByTabId: { 'agent-tab': ['pty-1'], 'shell-tab': ['pty-2'] }
  })
  store.setState({
    agentStatusByPaneKey: { 'agent-tab:leaf-1': agentEntry('agent-tab:leaf-1', 'agent-tab') }
  } as Partial<AppState>)
}

function dormancyOf(store: ReturnType<typeof createTestStore>, tabId: string) {
  return store.getState().tabsByWorktree[WT]?.find((t) => t.id === tabId)?.dormancy
}

async function sleep(store: ReturnType<typeof createTestStore>): Promise<void> {
  await store.getState().shutdownWorktreeTerminals(WT, { keepIdentifiers: true })
}

describe('workspace sleep — continuity verdict', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearRuntimeCompatibilityCacheForTests()
    mockApi.pty.kill.mockResolvedValue(undefined)
    mockApi.agentStatus.readTranscriptPresence.mockResolvedValue('unknown')
    mockUnregisterPtyDataHandlers.mockReturnValue([])
    applySleepRuntimeRpcDefault(mockApi)
    shutdownBufferCaptures.clear()
  })

  it('promises an exact resume only for a conversation the host FOUND, and keeps it through a restart', async () => {
    const store = createTestStore()
    seedLocalAgentWorkspace(store)
    mockApi.agentStatus.readTranscriptPresence.mockResolvedValue('present')

    await sleep(store)

    // Precondition: the sleep captured the agent's record, or nothing below means anything.
    expect(store.getState().sleepingAgentSessionsByPaneKey['agent-tab:leaf-1']).toBeDefined()
    expect(mockApi.agentStatus.readTranscriptPresence).toHaveBeenCalledWith({
      agent: 'codex',
      sessionId: 'session-agent',
      transcriptPath: TRANSCRIPT
    })
    expect(dormancyOf(store, 'agent-tab')).toEqual({
      reason: 'workspace-sleep',
      resumeContinuity: 'exact'
    })
    const agentTab = store.getState().tabsByWorktree[WT]!.find((t) => t.id === 'agent-tab')!
    expect(terminalTabSchema.parse(agentTab).dormancy?.resumeContinuity).toBe('exact')
  })

  it('says there is nothing to resume for a tab that held no conversation', async () => {
    const store = createTestStore()
    seedLocalAgentWorkspace(store)
    mockApi.agentStatus.readTranscriptPresence.mockResolvedValue('present')

    await sleep(store)

    expect(dormancyOf(store, 'shell-tab')).toEqual({
      reason: 'workspace-sleep',
      resumeContinuity: 'none'
    })
  })

  it.each(['unknown', 'absent'] as const)(
    'withholds the promise when the transcript is %s, and still offers the row',
    async (answer) => {
      const store = createTestStore()
      seedLocalAgentWorkspace(store)
      mockApi.agentStatus.readTranscriptPresence.mockResolvedValue(answer)

      await sleep(store)

      expect(dormancyOf(store, 'agent-tab')?.resumeContinuity).toBe('unconfirmed')
      // The row is still resumable: its handle survives, only certainty is withdrawn.
      expect(store.getState().sleepingAgentSessionsByPaneKey['agent-tab:leaf-1']).toBeDefined()
    }
  )

  it('withholds the promise and still sleeps when the probe cannot be delivered', async () => {
    const store = createTestStore()
    seedLocalAgentWorkspace(store)
    mockApi.agentStatus.readTranscriptPresence.mockRejectedValue(new Error('ipc gone'))

    await sleep(store)

    expect(dormancyOf(store, 'agent-tab')?.resumeContinuity).toBe('unconfirmed')
    expect(store.getState().ptyIdsByTabId['agent-tab']).toEqual([])
  })

  it('asks before anything is stopped', async () => {
    const store = createTestStore()
    seedLocalAgentWorkspace(store)
    mockApi.agentStatus.readTranscriptPresence.mockResolvedValue('present')

    await sleep(store)

    const asked = mockApi.agentStatus.readTranscriptPresence.mock.invocationCallOrder[0]
    const firstKill = mockApi.pty.kill.mock.invocationCallOrder[0]
    expect(asked).toBeDefined()
    expect(firstKill).toBeDefined()
    expect(asked!).toBeLessThan(firstKill!)
  })

  it('never probes a runtime-hosted workspace, whose transcripts this process cannot see', async () => {
    const store = createTestStore()
    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'runtime-1' },
      worktreesByRepo: {
        repo1: [makeRuntimeOwnedWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: { [WT]: [makeTab({ id: 'remote-tab', worktreeId: WT })] },
      ptyIdsByTabId: { 'remote-tab': ['remote:runtime-1@@pty-1'] }
    })
    store.setState({
      agentStatusByPaneKey: { 'remote-tab:leaf-1': agentEntry('remote-tab:leaf-1', 'remote-tab') }
    } as Partial<AppState>)
    mockApi.agentStatus.readTranscriptPresence.mockResolvedValue('present')

    await sleep(store)

    expect(store.getState().sleepingAgentSessionsByPaneKey['remote-tab:leaf-1']).toBeDefined()
    expect(mockApi.agentStatus.readTranscriptPresence).not.toHaveBeenCalled()
    expect(dormancyOf(store, 'remote-tab')?.resumeContinuity).toBe('unconfirmed')
  })
})
