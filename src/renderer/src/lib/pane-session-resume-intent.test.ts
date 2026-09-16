import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { LiveSessionMaterializationResponse } from '../../../shared/live-agent-session-presence-types'
import type { PaneSessionResumeCapability } from './pane-session-resume-capability'
import type {
  PaneSessionRespawnResult,
  PaneSessionResumeStartup
} from './pane-session-resume-intent'

type FakeState = {
  record: SleepingAgentSessionRecord | undefined
  capability: PaneSessionResumeCapability
}
let fake: FakeState

vi.mock('@/lib/pane-session-resume-capability', () => ({
  readPaneSessionResumeCapability: () => fake.capability,
  planPaneSessionResume: () =>
    fake.record
      ? {
          record: fake.record,
          plan: {
            agent: fake.record.agent,
            launchCommand: `claude --resume ${fake.record.providerSession.id}`,
            expectedProcess: 'claude',
            followupPrompt: null,
            launchConfig: { agentArgs: '', agentEnv: { PROFILE: 'recorded' } },
            env: { PROFILE: 'recorded' }
          }
        }
      : null
}))

const { resumePaneSession } = await import('./pane-session-resume-intent')

const TARGET = { paneKey: 'tab-1:leaf-1', tabId: 'tab-1', worktreeId: 'wt-1' }
const SESSION_S = { key: 'session_id' as const, id: 'session-s' }

function exitedRecord(id = 'session-s'): SleepingAgentSessionRecord {
  return Object.freeze({
    paneKey: TARGET.paneKey,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: Object.freeze({ key: 'session_id', id }),
    prompt: '',
    state: 'working',
    capturedAt: 1,
    updatedAt: 2,
    origin: 'live',
    automaticResumeBlockedBy: 'agent-exited'
  }) as SleepingAgentSessionRecord
}

const granted: LiveSessionMaterializationResponse = {
  outcome: 'granted',
  presence: {
    kind: 'live-here',
    liveElsewhere: [],
    ownersRevision: '',
    unknownCount: 0,
    staleCount: 0
  }
}
const liveElsewhere: LiveSessionMaterializationResponse = {
  outcome: 'blocked',
  presence: {
    kind: 'live-elsewhere',
    liveElsewhere: ['tab-2:leaf'],
    ownersRevision: 'tab-2:leaf@pty-9',
    unknownCount: 0,
    staleCount: 0
  }
}

let calls: string[]
let reserveMaterialization: ReturnType<typeof vi.fn>
const materialization = {
  attachMaterializationTab: vi.fn(async () => {
    calls.push('attach')
    return true
  }),
  releaseMaterialization: vi.fn(async () => {
    calls.push('release')
  })
}

function respawnReturning(result: PaneSessionRespawnResult) {
  return vi.fn(async (_startup: PaneSessionResumeStartup): Promise<PaneSessionRespawnResult> => {
    calls.push('respawn')
    return result
  })
}

const spawned = {
  kind: 'spawned' as const,
  ptyId: 'pty-new',
  previousPtyId: 'pty-old',
  reattached: false
}

function run(
  respawn: Parameters<typeof resumePaneSession>[0]['respawn'],
  confirm: Parameters<typeof resumePaneSession>[0]['confirm'] = null
) {
  return resumePaneSession({
    target: TARGET,
    confirm,
    respawn,
    getState: () => ({}) as AppState,
    materialization
  })
}

describe('resumePaneSession', () => {
  beforeEach(() => {
    calls = []
    fake = { record: exitedRecord(), capability: { kind: 'available' } }
    reserveMaterialization = vi.fn(async () => {
      calls.push('reserve')
      return granted
    })
    vi.stubGlobal('window', { api: { agentStatus: { reserveMaterialization } } })
    materialization.attachMaterializationTab.mockClear()
    materialization.releaseMaterialization.mockClear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reserves, attaches this tab, then respawns the exact retained session', async () => {
    const respawn = respawnReturning(spawned)

    await expect(run(respawn)).resolves.toEqual({ outcome: 'started' })

    expect(calls).toEqual(['reserve', 'attach', 'respawn'])
    expect(reserveMaterialization.mock.calls[0][0]).toMatchObject({
      paneKey: TARGET.paneKey,
      providerSession: SESSION_S
    })
    expect(materialization.attachMaterializationTab).toHaveBeenCalledWith({
      operationId: reserveMaterialization.mock.calls[0][0].operationId,
      tabId: 'tab-1'
    })
    const startup = respawn.mock.calls[0][0]
    expect(startup).toMatchObject({
      command: 'claude --resume session-s',
      resumeProviderSession: SESSION_S,
      launchAgent: 'claude',
      launchConfig: { agentEnv: { PROFILE: 'recorded' } }
    })
    expect(startup.env).toEqual({
      PROFILE: 'recorded',
      ORCA_AGENT_LAUNCH_TOKEN: startup.launchToken
    })
    expect(materialization.releaseMaterialization).not.toHaveBeenCalled()
  })

  it('does nothing when the pane cannot offer the action', async () => {
    fake.capability = { kind: 'disabled', reason: 'shell-unconfirmed' }
    const respawn = respawnReturning(spawned)

    await expect(run(respawn)).resolves.toEqual({
      outcome: 'unavailable',
      capability: { kind: 'disabled', reason: 'shell-unconfirmed' }
    })
    expect(calls).toEqual([])
  })

  it('stops at Back without spawning or reserving anything', async () => {
    reserveMaterialization.mockImplementation(async () => {
      calls.push('reserve')
      return liveElsewhere
    })
    const respawn = respawnReturning(spawned)

    await expect(
      run(
        respawn,
        vi.fn(async () => false)
      )
    ).resolves.toEqual({ outcome: 'cancelled' })
    expect(calls).toEqual(['reserve'])
  })

  it('gives the reservation back when main refuses the spawn', async () => {
    const respawn = respawnReturning({ ...spawned, agentResumeRefused: 'materializing' })

    await expect(run(respawn)).resolves.toEqual({ outcome: 'blocked', reason: 'materializing' })
    expect(calls).toEqual(['reserve', 'attach', 'respawn', 'release'])
  })

  it('gives the reservation back when the spawn fails', async () => {
    const respawn = vi.fn(async () => {
      calls.push('respawn')
      throw new Error('pty spawn failed')
    })

    await expect(run(respawn)).resolves.toEqual({ outcome: 'spawn-failed' })
    expect(calls).toEqual(['reserve', 'attach', 'respawn', 'release'])
  })

  it('does not call adopting the old shell a resume', async () => {
    await expect(run(respawnReturning({ ...spawned, reattached: true }))).resolves.toEqual({
      outcome: 'spawn-failed'
    })
    await expect(
      run(respawnReturning({ ...spawned, ptyId: 'pty-old', previousPtyId: 'pty-old' }))
    ).resolves.toEqual({ outcome: 'spawn-failed' })
    expect(materialization.releaseMaterialization).toHaveBeenCalledTimes(2)
  })

  it('abandons the attempt when the pane moved on to another session during the dialog', async () => {
    reserveMaterialization.mockImplementation(async () => {
      calls.push('reserve')
      fake.record = exitedRecord('session-t')
      return granted
    })
    const respawn = respawnReturning(spawned)

    await expect(run(respawn)).resolves.toEqual({
      outcome: 'unavailable',
      capability: { kind: 'hidden' }
    })
    expect(calls).toEqual(['reserve', 'release'])
  })

  it('never writes the retained record on any path', async () => {
    const record = fake.record
    await run(respawnReturning(spawned))
    await run(respawnReturning({ kind: 'failed' }))
    // The record is frozen: any write would have thrown inside the attempt.
    expect(fake.record).toBe(record)
    expect(record?.automaticResumeBlockedBy).toBe('agent-exited')
    expect(record?.providerSession).toEqual(SESSION_S)
  })
})
