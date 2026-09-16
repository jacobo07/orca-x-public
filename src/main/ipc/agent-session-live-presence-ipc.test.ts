import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { LiveAgentSessionPresenceReaderDeps } from '../agent-hooks/live-agent-session-presence-reader'

const { handleMock, removeHandlerMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, removeHandler: removeHandlerMock }
}))

import {
  handleLiveAgentSessionPresenceRequest,
  registerAgentSessionLivePresenceHandlers
} from './agent-session-live-presence-ipc'

const OWNER_PANE = 'tab-a:11111111-1111-4111-8111-111111111111'
const REQUESTER_PANE = 'tab-b:22222222-2222-4222-8222-222222222222'
const SESSION_ID = 'claude-session-secret-a'

function row(paneKey: string): AgentStatusIpcPayload {
  return {
    paneKey,
    state: 'done',
    prompt: '',
    agentType: 'claude',
    worktreeId: 'worktree-1',
    connectionId: null,
    receivedAt: 1,
    stateStartedAt: 1,
    providerSession: { key: 'session_id', id: SESSION_ID }
  }
}

function deps(overrides: Partial<LiveAgentSessionPresenceReaderDeps> = {}) {
  return {
    listHookRows: () => [row(OWNER_PANE)],
    isObservedInCurrentRuntime: () => true,
    resolveIdentityKey: async () => 'claim-key',
    getBoundPtyIdForPaneKey: () => 'pty-1',
    getPersistedPtyIdForPaneKey: () => undefined,
    probePtyLiveness: async () => true,
    ...overrides
  } satisfies LiveAgentSessionPresenceReaderDeps
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    paneKey: REQUESTER_PANE,
    worktreeId: 'worktree-2',
    agent: 'claude',
    providerSession: { key: 'session_id', id: SESSION_ID },
    ...overrides
  }
}

describe('handleLiveAgentSessionPresenceRequest', () => {
  it('names the pane that owns the session without echoing provider identifiers', async () => {
    const response = await handleLiveAgentSessionPresenceRequest(deps(), request())

    expect(response).toEqual({
      kind: 'live-elsewhere',
      liveElsewhere: [OWNER_PANE],
      unknownCount: 0,
      staleCount: 0
    })
    expect(JSON.stringify(response)).not.toContain(SESSION_ID)
  })

  it('counts stale and unknown panes without calling them owners', async () => {
    const response = await handleLiveAgentSessionPresenceRequest(
      deps({
        listHookRows: () => [row(OWNER_PANE), row('tab-c:33333333-3333-4333-8333-333333333333')],
        probePtyLiveness: async (ptyId) => (ptyId === 'pty-a' ? false : null),
        getBoundPtyIdForPaneKey: (paneKey) => (paneKey === OWNER_PANE ? 'pty-a' : 'pty-c')
      }),
      request()
    )

    expect(response).toEqual({ kind: 'unknown', liveElsewhere: [], unknownCount: 1, staleCount: 1 })
  })

  it.each([
    ['no object', null],
    ['legacy numeric pane key', request({ paneKey: 'tab-b:3' })],
    ['non-resumable agent', request({ agent: 'not-an-agent' })],
    ['missing session id', request({ providerSession: { key: 'session_id' } })],
    ['empty worktree', request({ worktreeId: '' })]
  ])('answers unknown, never no-live-owner, for a malformed request: %s', async (_name, value) => {
    const listHookRows = vi.fn(() => [row(OWNER_PANE)])

    const response = await handleLiveAgentSessionPresenceRequest(deps({ listHookRows }), value)

    expect(response.kind).toBe('unknown')
    expect(listHookRows).not.toHaveBeenCalled()
  })

  it('answers unknown when the read itself fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const response = await handleLiveAgentSessionPresenceRequest(
      deps({
        listHookRows: () => {
          throw new Error('hook server unavailable')
        }
      }),
      request()
    )

    expect(response.kind).toBe('unknown')
    warn.mockRestore()
  })

  it('reports no live owner only when the read positively found none', async () => {
    const response = await handleLiveAgentSessionPresenceRequest(
      deps({ listHookRows: () => [] }),
      request()
    )

    expect(response.kind).toBe('no-live-owner')
  })
})

describe('preload bridge', () => {
  it('invokes the same channel the main process handles', async () => {
    const { readFileSync } = await import('node:fs')
    const { LIVE_AGENT_SESSION_PRESENCE_CHANNEL, LIVE_SESSION_COLLISION_CHANNEL } =
      await import('../../shared/live-agent-session-presence-types')
    const preload = readFileSync(new URL('../../preload/index.ts', import.meta.url), 'utf8')

    expect(preload).toContain(
      `ipcRenderer.invoke('${LIVE_AGENT_SESSION_PRESENCE_CHANNEL}', request)`
    )
    expect(preload).toContain(`ipcRenderer.on('${LIVE_SESSION_COLLISION_CHANNEL}', listener)`)
    expect(preload).toContain(
      `ipcRenderer.removeListener('${LIVE_SESSION_COLLISION_CHANNEL}', listener)`
    )
  })
})

describe('registerAgentSessionLivePresenceHandlers', () => {
  beforeEach(() => {
    handleMock.mockReset()
    removeHandlerMock.mockReset()
  })

  it('registers the channel without first removing another owner of it', async () => {
    const resolveDeps = vi.fn(() => deps())
    registerAgentSessionLivePresenceHandlers(resolveDeps)

    expect(removeHandlerMock).not.toHaveBeenCalled()
    expect(handleMock).toHaveBeenCalledWith('agentSession:readLivePresence', expect.any(Function))
    const handler = handleMock.mock.calls[0][1] as (
      event: unknown,
      value: unknown
    ) => Promise<unknown>
    await expect(handler({}, request())).resolves.toMatchObject({ kind: 'live-elsewhere' })
    expect(resolveDeps).toHaveBeenCalledTimes(1)
  })
})
