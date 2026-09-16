import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { LiveAgentSessionPresenceReaderDeps } from '../agent-hooks/live-agent-session-presence-reader'
import { LiveSessionMaterializationReservations } from '../agent-hooks/live-session-materialization-reservation'

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
      ownersRevision: `${OWNER_PANE}@pty-1`,
      unknownCount: 0,
      staleCount: 0
    })
    expect(JSON.stringify(response)).not.toContain(SESSION_ID)
  })

  it('accepts a request for a pane that does not exist yet', async () => {
    const { paneKey: _omitted, ...withoutPane } = request()

    const response = await handleLiveAgentSessionPresenceRequest(deps(), withoutPane)

    expect(response.kind).toBe('live-elsewhere')
  })

  it('changes the owners revision when the runtime behind the same pane is replaced', async () => {
    const before = await handleLiveAgentSessionPresenceRequest(deps(), request())
    const after = await handleLiveAgentSessionPresenceRequest(
      deps({ getBoundPtyIdForPaneKey: () => 'pty-2' }),
      request()
    )

    expect(after.liveElsewhere).toEqual(before.liveElsewhere)
    expect(after.ownersRevision).not.toBe(before.ownersRevision)
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

    expect(response).toEqual({
      kind: 'unknown',
      liveElsewhere: [],
      ownersRevision: '',
      unknownCount: 1,
      staleCount: 1
    })
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

  it('invokes the materialization channels the main process handles', async () => {
    const { readFileSync } = await import('node:fs')
    const channels = await import('../../shared/live-agent-session-presence-types')
    const preload = readFileSync(new URL('../../preload/index.ts', import.meta.url), 'utf8')

    expect(preload).toContain(
      `ipcRenderer.invoke('${channels.LIVE_SESSION_MATERIALIZATION_RESERVE_CHANNEL}', request)`
    )
    expect(preload).toContain(
      `ipcRenderer.invoke('${channels.LIVE_SESSION_MATERIALIZATION_ATTACH_CHANNEL}', args)`
    )
    expect(preload).toContain(
      `ipcRenderer.invoke('${channels.LIVE_SESSION_MATERIALIZATION_RELEASE_CHANNEL}', args)`
    )
  })
})

describe('registerAgentSessionLivePresenceHandlers', () => {
  beforeEach(() => {
    handleMock.mockReset()
    removeHandlerMock.mockReset()
  })

  function register() {
    const reservations = new LiveSessionMaterializationReservations({
      now: () => 0,
      hasBoundPty: () => false
    })
    const resolveDeps = vi.fn(() => deps({ listHookRows: () => [] }))
    registerAgentSessionLivePresenceHandlers(resolveDeps, () => reservations)
    const handler = (channel: string) =>
      handleMock.mock.calls.find(([name]) => name === channel)?.[1] as (
        event: unknown,
        value: unknown
      ) => Promise<unknown>
    const destroyedListeners = new Map<number, () => void>()
    const sender = (id: number) => ({
      id,
      once: (_event: 'destroyed', listener: () => void) => destroyedListeners.set(id, listener)
    })
    return { reservations, resolveDeps, handler, sender, destroyedListeners }
  }

  it('registers the channel without first removing another owner of it', async () => {
    const resolveDeps = vi.fn(() => deps())
    registerAgentSessionLivePresenceHandlers(resolveDeps, () => {
      throw new Error('presence reads never touch reservations')
    })

    expect(removeHandlerMock).not.toHaveBeenCalled()
    expect(handleMock).toHaveBeenCalledWith('agentSession:readLivePresence', expect.any(Function))
    const handler = handleMock.mock.calls[0][1] as (
      event: unknown,
      value: unknown
    ) => Promise<unknown>
    await expect(handler({}, request())).resolves.toMatchObject({ kind: 'live-elsewhere' })
    expect(resolveDeps).toHaveBeenCalledTimes(1)
  })

  it("drops a destroyed window's reservations and ignores another window's release", async () => {
    const { reservations, handler, sender, destroyedListeners } = register()
    const reserve = handler('agentSession:reserveMaterialization')
    const release = handler('agentSession:releaseMaterialization')
    const attach = handler('agentSession:attachMaterializationTab')

    await expect(
      reserve({ sender: sender(7) }, { ...request(), operationId: 'op-a' })
    ).resolves.toMatchObject({ outcome: 'granted' })
    await expect(
      Promise.resolve(attach({ sender: sender(8) }, { operationId: 'op-a', tabId: 'tab-a' }))
    ).resolves.toBe(false)
    await expect(
      Promise.resolve(attach({ sender: sender(7) }, { operationId: 'op-a', tabId: 'tab:bad' }))
    ).resolves.toBe(false)
    await release({ sender: sender(8) }, { operationId: 'op-a' })
    expect(reservations.size).toBe(1)

    destroyedListeners.get(7)?.()
    expect(reservations.size).toBe(0)
  })

  it('lets the owning window release its own reservation', async () => {
    const { reservations, handler, sender } = register()

    await handler('agentSession:reserveMaterialization')(
      { sender: sender(7) },
      { ...request(), operationId: 'op-a' }
    )
    await handler('agentSession:releaseMaterialization')(
      { sender: sender(7) },
      { operationId: 'op-a' }
    )

    expect(reservations.size).toBe(0)
  })
})
