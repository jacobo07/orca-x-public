import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { LiveAgentSessionPresenceReaderDeps } from '../agent-hooks/live-agent-session-presence-reader'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

import { handleLiveAgentSessionPresenceRequest } from './agent-session-live-presence-ipc'

const PANE_A = 'tab-a:11111111-1111-4111-8111-111111111111'
const SESSION = { key: 'session_id', id: 'claude-session-race' } as const

function hookRow(paneKey: string): AgentStatusIpcPayload {
  return {
    paneKey,
    state: 'working',
    prompt: '',
    agentType: 'claude',
    worktreeId: 'worktree-a',
    connectionId: null,
    receivedAt: 1,
    stateStartedAt: 1,
    providerSession: { ...SESSION }
  }
}

/** One host: hook rows appear only once a launched provider reports SessionStart. */
function host() {
  const rows: AgentStatusIpcPayload[] = []
  const deps: LiveAgentSessionPresenceReaderDeps = {
    listHookRows: () => rows,
    isObservedInCurrentRuntime: () => true,
    resolveIdentityKey: async () => 'claim-key',
    getBoundPtyIdForPaneKey: (paneKey) => (paneKey === PANE_A ? 'pty-a' : undefined),
    getPersistedPtyIdForPaneKey: () => undefined,
    probePtyLiveness: async () => true
  }
  return { deps, providerReported: (paneKey: string) => rows.push(hookRow(paneKey)) }
}

const request = (worktreeId: string) => ({ worktreeId, agent: 'claude', providerSession: SESSION })

describe('check-to-live gap for an Orca-selected resume (characterization)', () => {
  it('lets a second attempt read no owner while the first is still starting', async () => {
    const { deps, providerReported } = host()

    const a = await handleLiveAgentSessionPresenceRequest(deps, request('worktree-a'))
    // A has passed its check and launched; its provider has not reported yet.
    const b = await handleLiveAgentSessionPresenceRequest(deps, request('worktree-b'))

    expect(a.kind).toBe('no-live-owner')
    expect(b.kind).toBe('no-live-owner')

    // Positive control: the same read does see A once its provider reports.
    providerReported(PANE_A)
    const later = await handleLiveAgentSessionPresenceRequest(deps, request('worktree-b'))
    expect(later.kind).toBe('live-elsewhere')
  })
})
