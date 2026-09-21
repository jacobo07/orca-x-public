import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { LiveAgentSessionPresenceReaderDeps } from '../agent-hooks/live-agent-session-presence-reader'
import {
  LiveSessionMaterializationReservations,
  MATERIALIZATION_UNBOUND_CEILING_MS
} from '../agent-hooks/live-session-materialization-reservation'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

import { handleLiveSessionMaterializationRequest } from './agent-session-live-presence-ipc'
import { decideResumeSpawn } from './agent-session-resume-spawn-gate'

const WINDOW_1 = 1
const WINDOW_2 = 2
const LEAF = '11111111-1111-4111-8111-111111111111'
const paneOf = (tabId: string) => `${tabId}:${LEAF}`

type Session = { key: 'session_id'; id: string }
const S: Session = { key: 'session_id', id: 'claude-session-s' }
const T: Session = { key: 'session_id', id: 'claude-session-t' }

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** One host process shared by every Orca materializer: AI Vault reserves through IPC,
 *  sleep launch / cold restore / hibernation wake / working-set revival reach the spawn. */
function host(overrides: Partial<LiveAgentSessionPresenceReaderDeps> = {}) {
  let now = 10_000
  let minted = 0
  const rows: AgentStatusIpcPayload[] = []
  const ptyByTab = new Map<string, boolean>()
  const reservations = new LiveSessionMaterializationReservations({
    now: () => now,
    hasBoundPty: (tabId) => ptyByTab.get(tabId) === true
  })
  const deps: LiveAgentSessionPresenceReaderDeps = {
    listHookRows: () => rows,
    isObservedInCurrentRuntime: () => true,
    resolveIdentityKey: async ({ providerSession }) => `claim:${providerSession.id}`,
    getBoundPtyIdForPaneKey: (paneKey) => {
      const tabId = paneKey.split(':')[0]
      return ptyByTab.has(tabId) ? `pty-${tabId}` : undefined
    },
    getPersistedPtyIdForPaneKey: () => undefined,
    probePtyLiveness: async (ptyId) => ptyByTab.get(ptyId.slice(4)) ?? false,
    ...overrides
  }
  return {
    deps,
    reservations,
    /** AI Vault: the user-initiated Class A path, with its own dialog. */
    vault: (
      operationId: string,
      session: Session,
      opts: { window?: number; accept?: { kind: string; ownersRevision: string } } = {}
    ) =>
      handleLiveSessionMaterializationRequest(deps, reservations, opts.window ?? WINDOW_1, {
        worktreeId: 'worktree-a',
        agent: 'claude',
        providerSession: session,
        operationId,
        ...(opts.accept ? { accept: opts.accept } : {})
      }),
    /** Any pane spawn that carries a resume: the automatic materializers. */
    spawn: (
      tabId: string,
      session: Session,
      opts: { window?: number; worktreeId?: string; deps?: LiveAgentSessionPresenceReaderDeps } = {}
    ) =>
      decideResumeSpawn(
        opts.deps ?? deps,
        reservations,
        {
          ownerId: opts.window ?? WINDOW_1,
          worktreeId: opts.worktreeId ?? 'worktree-a',
          tabId,
          leafId: LEAF,
          agent: 'claude',
          providerSession: session
        },
        () => `spawn-op-${++minted}`
      ),
    ptyStarted: (tabId: string) => ptyByTab.set(tabId, true),
    providerReported: (tabId: string, session: Session) =>
      rows.push({
        paneKey: paneOf(tabId),
        state: 'working',
        prompt: '',
        agentType: 'claude',
        worktreeId: 'worktree-a',
        connectionId: null,
        receivedAt: 1,
        stateStartedAt: 1,
        providerSession: { ...session }
      }),
    ptyExited: (tabId: string) => {
      ptyByTab.set(tabId, false)
      reservations.releaseForTab(tabId)
    },
    advance: (ms: number) => {
      now += ms
    }
  }
}

describe('resume spawn gate — one authority across materializers', () => {
  it('refuses a sleep/cold-restore spawn while an AI Vault resume is starting the session', async () => {
    const h = host()
    expect((await h.vault('op-vault', S)).outcome).toBe('granted')
    h.reservations.attachTab('op-vault', WINDOW_1, 'tab-vault')

    expect(await h.spawn('tab-sleep', S, { window: WINDOW_2 })).toEqual({
      outcome: 'refused',
      reason: 'materializing'
    })
    // The vault's own pane still materializes.
    expect((await h.spawn('tab-vault', S)).outcome).toBe('proceed')
    expect(h.reservations.holder('claim:claude-session-s')?.operationId).toBe('op-vault')
  })

  it('tells AI Vault the session is starting while an automatic spawn holds it', async () => {
    const h = host()
    expect(await h.spawn('tab-restore', S)).toEqual({
      outcome: 'proceed',
      operationId: 'spawn-op-1'
    })
    h.ptyStarted('tab-restore')

    expect(await h.vault('op-vault', S, { window: WINDOW_2 })).toMatchObject({
      outcome: 'blocked',
      presence: { kind: 'materializing' }
    })
  })

  it('lets only one of two automatic spawns through when both read "no owner"', async () => {
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
    // Sleep launch in one tab, working-set revival of a different row in another.
    const sleep = h.spawn('tab-sleep', S, { deps })
    const workingSet = h.spawn('tab-working-set', S, { deps, window: WINDOW_2 })
    await vi.waitFor(() => expect(reads).toBe(2))
    expect(h.reservations.size).toBe(0)
    gate.resolve()

    const outcomes = (await Promise.all([sleep, workingSet])).map((d) => d.outcome)
    expect(outcomes.sort()).toEqual(['proceed', 'refused'])
    expect(h.reservations.size).toBe(1)
  })

  it('collides across local records and projects, not across different sessions', async () => {
    const h = host()
    expect((await h.spawn('tab-a', S, { worktreeId: 'project-one' })).outcome).toBe('proceed')
    // Same session from another project's record: one provider session, one claim.
    expect((await h.spawn('tab-b', S, { worktreeId: 'project-two' })).outcome).toBe('refused')
    // Same worktree, different session: independent.
    expect((await h.spawn('tab-c', T, { worktreeId: 'project-one' })).outcome).toBe('proceed')
  })

  it('refuses an automatic spawn of a session live elsewhere and never overrides it', async () => {
    const h = host()
    h.providerReported('tab-live', S)
    h.ptyStarted('tab-live')

    expect(await h.spawn('tab-wake', S)).toEqual({
      outcome: 'refused',
      reason: 'live-elsewhere'
    })
    expect(await h.spawn('tab-wake', S)).toMatchObject({ outcome: 'refused' })
    expect(h.reservations.size).toBe(0)
  })

  it('carries an explicit Continue to exactly one spawn of the tab it named', async () => {
    const h = host()
    h.providerReported('tab-live', S)
    h.ptyStarted('tab-live')
    const seen = await h.vault('op-vault', S)
    expect(seen.presence.kind).toBe('live-elsewhere')
    expect((await h.vault('op-vault', S, { accept: seen.presence })).outcome).toBe('granted')
    h.reservations.attachTab('op-vault', WINDOW_1, 'tab-vault')

    // An automatic spawn elsewhere does not inherit the consent.
    expect((await h.spawn('tab-wake', S)).outcome).toBe('refused')
    expect((await h.spawn('tab-vault', S)).outcome).toBe('proceed')
  })

  it('lets an accepted in-flight duplicate spawn once, then asks again', async () => {
    const h = host()
    await h.vault('op-a', S)
    h.reservations.attachTab('op-a', WINDOW_1, 'tab-a')
    const seen = await h.vault('op-b', S, { window: WINDOW_2 })
    expect(seen.presence.kind).toBe('materializing')
    expect((await h.vault('op-b', S, { window: WINDOW_2, accept: seen.presence })).outcome).toBe(
      'granted'
    )
    h.reservations.attachTab('op-b', WINDOW_2, 'tab-b')

    expect((await h.spawn('tab-b', S, { window: WINDOW_2 })).outcome).toBe('proceed')
    // A respawn of the same tab is a new effect: the permit was consumed.
    expect(await h.spawn('tab-b', S, { window: WINDOW_2 })).toEqual({
      outcome: 'refused',
      reason: 'materializing'
    })
    expect(h.reservations.holder('claim:claude-session-s')?.operationId).toBe('op-a')
  })

  it('expires an unused Continue with the unbound ceiling', async () => {
    const h = host()
    await h.vault('op-a', S)
    const seen = await h.vault('op-b', S, { window: WINDOW_2 })
    await h.vault('op-b', S, { window: WINDOW_2, accept: seen.presence })
    h.reservations.attachTab('op-b', WINDOW_2, 'tab-b')
    h.advance(MATERIALIZATION_UNBOUND_CEILING_MS + 1)

    expect(h.reservations.permitCount).toBe(1)
    // op-a expired too, so the spawn proceeds on its own fresh claim, not on the stale permit.
    expect(await h.spawn('tab-b', S, { window: WINDOW_2 })).toEqual({
      outcome: 'proceed',
      operationId: 'spawn-op-1'
    })
    expect(h.reservations.permitCount).toBe(0)
  })

  it('frees the session when the granted spawn fails or its window closes', async () => {
    const h = host()
    const first = await h.spawn('tab-a', S)
    expect(first).toEqual({ outcome: 'proceed', operationId: 'spawn-op-1' })
    // Another window's release does nothing.
    h.reservations.release('spawn-op-1', WINDOW_2)
    expect((await h.spawn('tab-b', S, { window: WINDOW_2 })).outcome).toBe('refused')

    h.reservations.release('spawn-op-1', WINDOW_1)
    const second = await h.spawn('tab-b', S, { window: WINDOW_2 })
    expect(second.outcome).toBe('proceed')

    h.reservations.releaseForOwner(WINDOW_2)
    expect((await h.spawn('tab-c', S)).outcome).toBe('proceed')
  })

  it('keeps holding through the launch and hands off only to proven presence', async () => {
    const h = host()
    await h.spawn('tab-a', S)
    h.ptyStarted('tab-a')
    // Past the unbound ceiling but bound: still starting, not free.
    h.advance(MATERIALIZATION_UNBOUND_CEILING_MS + 1)
    expect(await h.spawn('tab-b', S)).toMatchObject({ reason: 'materializing' })

    h.providerReported('tab-a', S)
    expect(await h.spawn('tab-b', S)).toMatchObject({ reason: 'live-elsewhere' })
    expect(h.reservations.size).toBe(0)
  })

  it('re-reads presence after a reservation times out instead of treating it as dead', async () => {
    const h = host()
    await h.spawn('tab-a', S)
    h.ptyStarted('tab-a')
    // The provider reported after the bound ceiling reaped the reservation.
    h.advance(200_000)
    h.providerReported('tab-a', S)

    expect(await h.spawn('tab-b', S)).toMatchObject({ reason: 'live-elsewhere' })
  })

  it('refuses when presence cannot be read and proceeds unreserved without identity', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const broken = host({
      listHookRows: () => {
        throw new Error('hook server unavailable')
      }
    })
    expect(await broken.spawn('tab-a', S)).toEqual({ outcome: 'refused', reason: 'unknown' })
    warn.mockRestore()

    const unplaced = host({ resolveIdentityKey: async () => null })
    expect(await unplaced.spawn('tab-a', S)).toEqual({ outcome: 'proceed', operationId: null })
    expect(unplaced.reservations.size).toBe(0)

    const unprovable = host({ probePtyLiveness: async () => null })
    unprovable.providerReported('tab-x', S)
    unprovable.ptyStarted('tab-x')
    expect(await unprovable.spawn('tab-a', S)).toEqual({ outcome: 'refused', reason: 'unknown' })
  })

  it('lets a pane whose previous runtime died resume its own session', async () => {
    const h = host({ probePtyLiveness: async () => false })
    h.providerReported('tab-a', S)
    h.ptyStarted('tab-a')

    expect((await h.spawn('tab-a', S)).outcome).toBe('proceed')
  })
})
