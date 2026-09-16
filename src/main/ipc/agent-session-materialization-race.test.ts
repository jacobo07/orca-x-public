import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { LiveAgentSessionPresenceReaderDeps } from '../agent-hooks/live-agent-session-presence-reader'
import {
  LiveSessionMaterializationReservations,
  MATERIALIZATION_UNBOUND_CEILING_MS
} from '../agent-hooks/live-session-materialization-reservation'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

import { handleLiveSessionMaterializationRequest } from './agent-session-live-presence-ipc'

const WINDOW_1 = 1
const WINDOW_2 = 2
const LEAF = '11111111-1111-4111-8111-111111111111'
const paneOf = (tabId: string) => `${tabId}:${LEAF}`

type Session = { key: 'session_id'; id: string }
const S: Session = { key: 'session_id', id: 'claude-session-s' }
const T: Session = { key: 'session_id', id: 'claude-session-t' }

function hookRow(tabId: string, session: Session): AgentStatusIpcPayload {
  return {
    paneKey: paneOf(tabId),
    state: 'working',
    prompt: '',
    agentType: 'claude',
    worktreeId: 'worktree-a',
    connectionId: null,
    receivedAt: 1,
    stateStartedAt: 1,
    providerSession: { ...session }
  }
}

/** One host process. Hook rows appear only once a launched provider reports, and a
 *  tab has a PTY only once its pane spawned. */
function host(overrides: Partial<LiveAgentSessionPresenceReaderDeps> = {}) {
  let now = 10_000
  const rows: AgentStatusIpcPayload[] = []
  const ptyByTab = new Map<string, boolean>()
  const reservations = new LiveSessionMaterializationReservations({
    now: () => now,
    hasBoundPty: (tabId) => ptyByTab.get(tabId) === true
  })
  const deps: LiveAgentSessionPresenceReaderDeps = {
    listHookRows: () => rows,
    isObservedInCurrentRuntime: () => true,
    // Canonical key: the provider session, never the worktree it is opened in.
    resolveIdentityKey: async ({ providerSession }) => `claim:${providerSession.id}`,
    getBoundPtyIdForPaneKey: (paneKey) => {
      const tabId = paneKey.split(':')[0]
      return ptyByTab.has(tabId) ? `pty-${tabId}` : undefined
    },
    getPersistedPtyIdForPaneKey: () => undefined,
    probePtyLiveness: async (ptyId) => ptyByTab.get(ptyId.slice(4)) ?? false,
    ...overrides
  }
  const reserve = (
    operationId: string,
    session: Session,
    opts: {
      worktreeId?: string
      window?: number
      accept?: { kind: string; ownersRevision: string }
      deps?: LiveAgentSessionPresenceReaderDeps
    } = {}
  ) =>
    handleLiveSessionMaterializationRequest(
      opts.deps ?? deps,
      reservations,
      opts.window ?? WINDOW_1,
      {
        worktreeId: opts.worktreeId ?? 'worktree-a',
        agent: 'claude',
        providerSession: session,
        operationId,
        ...(opts.accept ? { accept: opts.accept } : {})
      }
    )
  return {
    deps,
    reservations,
    reserve,
    /** The granted operation's tab mounted and its PTY spawned. */
    spawned: (operationId: string, tabId: string, window = WINDOW_1) => {
      reservations.attachTab(operationId, window, tabId)
      ptyByTab.set(tabId, true)
    },
    providerReported: (tabId: string, session: Session) => rows.push(hookRow(tabId, session)),
    ptyExited: (tabId: string) => {
      ptyByTab.set(tabId, false)
      reservations.releaseForTab(tabId)
    },
    advance: (ms: number) => {
      now += ms
    }
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('materialization reservation — controlled interleaving', () => {
  it('grants only one of two attempts that both passed the presence check', async () => {
    const h = host()
    const gate = deferred()
    let reads = 0
    const deps = {
      ...h.deps,
      resolveIdentityKey: async (args: Parameters<typeof h.deps.resolveIdentityKey>[0]) => {
        reads += 1
        await gate.promise
        return h.deps.resolveIdentityKey(args)
      }
    }

    const a = h.reserve('op-a', S, { deps, window: WINDOW_1 })
    const b = h.reserve('op-b', S, { deps, window: WINDOW_2 })
    await vi.waitFor(() => expect(reads).toBe(2))
    // Both reads are now in flight and neither attempt holds anything.
    expect(h.reservations.size).toBe(0)
    gate.resolve()
    const [ra, rb] = await Promise.all([a, b])

    expect([ra.outcome, rb.outcome].sort()).toEqual(['blocked', 'granted'])
    const loser = ra.outcome === 'blocked' ? ra : rb
    expect(loser.presence.kind).toBe('materializing')
    expect(h.reservations.size).toBe(1)
  })

  it('holds through the launch and hands off to live presence without a gap', async () => {
    const h = host()
    expect((await h.reserve('op-a', S)).outcome).toBe('granted')
    h.spawned('op-a', 'tab-a')

    // Spawned, provider not reported yet: still refused, and never called open.
    const starting = await h.reserve('op-b', S, { window: WINDOW_2 })
    expect(starting).toMatchObject({ outcome: 'blocked', presence: { kind: 'materializing' } })

    h.providerReported('tab-a', S)
    const live = await h.reserve('op-b', S, { window: WINDOW_2 })
    expect(live).toMatchObject({ outcome: 'blocked', presence: { kind: 'live-elsewhere' } })
    // Presence owns the truth now; the reservation is gone.
    expect(h.reservations.size).toBe(0)
  })

  it('does not serialize unrelated sessions', async () => {
    const h = host()
    const [a, b] = await Promise.all([
      h.reserve('op-a', S),
      h.reserve('op-b', T, { window: WINDOW_2 })
    ])

    expect(a.outcome).toBe('granted')
    expect(b.outcome).toBe('granted')
  })

  it('contends the same session opened from another project', async () => {
    const h = host()
    const [a, b] = await Promise.all([
      h.reserve('op-a', S, { worktreeId: 'project-one' }),
      h.reserve('op-b', S, { worktreeId: 'project-two', window: WINDOW_2 })
    ])

    expect([a.outcome, b.outcome].sort()).toEqual(['blocked', 'granted'])
  })

  it('frees the session when the first attempt never spawns', async () => {
    const h = host()
    await h.reserve('op-a', S)
    h.reservations.attachTab('op-a', WINDOW_1, 'tab-a')

    expect((await h.reserve('op-b', S, { window: WINDOW_2 })).outcome).toBe('blocked')
    h.advance(MATERIALIZATION_UNBOUND_CEILING_MS + 1)
    expect((await h.reserve('op-b', S, { window: WINDOW_2 })).outcome).toBe('granted')
  })

  it('frees the session when the first runtime exits before reporting', async () => {
    const h = host()
    await h.reserve('op-a', S)
    h.spawned('op-a', 'tab-a')
    h.ptyExited('tab-a')

    expect((await h.reserve('op-b', S, { window: WINDOW_2 })).outcome).toBe('granted')
  })

  it('refuses and reserves nothing when the presence read fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = host({
      listHookRows: () => {
        throw new Error('hook server unavailable')
      }
    })

    const result = await h.reserve('op-a', S)

    expect(result).toMatchObject({ outcome: 'blocked', presence: { kind: 'unknown' } })
    expect(h.reservations.size).toBe(0)
    warn.mockRestore()
  })

  it('keeps an unprovable owner unknown and a dead one out of the way', async () => {
    const unknownHost = host({ probePtyLiveness: async () => null })
    unknownHost.providerReported('tab-x', S)
    unknownHost.spawned('none', 'tab-x')
    expect(await unknownHost.reserve('op-a', S)).toMatchObject({
      outcome: 'blocked',
      presence: { kind: 'unknown' }
    })

    const staleHost = host({ probePtyLiveness: async () => false })
    staleHost.providerReported('tab-x', S)
    staleHost.spawned('none', 'tab-x')
    expect((await staleHost.reserve('op-a', S)).outcome).toBe('granted')
  })

  it('shows a proven live owner, not an in-progress attempt, when both exist', async () => {
    const h = host()
    h.providerReported('tab-live', S)
    h.spawned('none', 'tab-live')
    const first = await h.reserve('op-a', S)
    expect(first.presence.kind).toBe('live-elsewhere')

    // A accepts the live collision and starts a second copy.
    const override = await h.reserve('op-a', S, { accept: first.presence })
    expect(override.outcome).toBe('granted')

    const other = await h.reserve('op-b', S, { window: WINDOW_2 })
    expect(other.presence.kind).toBe('live-elsewhere')
    // Accepting the same live collision does not let a second copy start alongside A's.
    const secondOverride = await h.reserve('op-b', S, {
      window: WINDOW_2,
      accept: other.presence
    })
    expect(secondOverride).toMatchObject({
      outcome: 'blocked',
      presence: { kind: 'materializing' }
    })
  })

  it('treats Continue past an in-progress attempt as one-shot and holder-bound', async () => {
    const h = host()
    await h.reserve('op-a', S)
    const seen = await h.reserve('op-b', S, { window: WINDOW_2 })
    expect(seen.presence.kind).toBe('materializing')

    const accepted = await h.reserve('op-b', S, { window: WINDOW_2, accept: seen.presence })
    expect(accepted.outcome).toBe('granted')
    // The explicit duplicate does not displace the holder.
    expect(h.reservations.holder('claim:claude-session-s')?.operationId).toBe('op-a')

    // Nothing was remembered: the next attempt asks again.
    expect((await h.reserve('op-c', S, { window: WINDOW_2 })).outcome).toBe('blocked')

    // A different holder is a different question.
    h.reservations.release('op-a', WINDOW_1)
    await h.reserve('op-d', S)
    const stale = await h.reserve('op-b', S, { window: WINDOW_2, accept: seen.presence })
    expect(stale).toMatchObject({ outcome: 'blocked', presence: { kind: 'materializing' } })
  })

  it('answers a retried request as granted without a second reservation', async () => {
    const h = host()

    expect((await h.reserve('op-a', S)).outcome).toBe('granted')
    expect((await h.reserve('op-a', S)).outcome).toBe('granted')
    expect(h.reservations.size).toBe(1)
    // The same id from another window is someone else.
    expect((await h.reserve('op-a', S, { window: WINDOW_2 })).outcome).toBe('blocked')
  })

  it('proceeds without reserving when the host cannot place the identity', async () => {
    const h = host({ resolveIdentityKey: async () => null })

    expect((await h.reserve('op-a', S)).outcome).toBe('granted')
    expect(h.reservations.size).toBe(0)
  })

  it.each([
    ['no operation id', { worktreeId: 'w', agent: 'claude', providerSession: S }],
    [
      'malformed accept',
      {
        worktreeId: 'w',
        agent: 'claude',
        providerSession: S,
        operationId: 'op',
        accept: { kind: 'open' }
      }
    ]
  ])('refuses a malformed request: %s', async (_name, value) => {
    const h = host()

    const result = await handleLiveSessionMaterializationRequest(
      h.deps,
      h.reservations,
      WINDOW_1,
      value
    )

    expect(result).toMatchObject({ outcome: 'blocked', presence: { kind: 'unknown' } })
    expect(h.reservations.size).toBe(0)
  })
})
