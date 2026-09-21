import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import {
  readLiveAgentSessionPresence,
  type LiveAgentSessionPresenceReaderDeps
} from './live-agent-session-presence-reader'

const SESSION: AgentProviderSessionMetadata = { key: 'session_id', id: 'claude-session-a' }

function row(
  paneKey: string,
  overrides: Partial<AgentStatusIpcPayload> = {}
): AgentStatusIpcPayload {
  return {
    paneKey,
    state: 'working',
    prompt: '',
    agentType: 'claude',
    worktreeId: 'worktree-1',
    connectionId: null,
    receivedAt: 1,
    stateStartedAt: 1,
    providerSession: SESSION,
    ...overrides
  }
}

function deps(
  rows: AgentStatusIpcPayload[],
  overrides: Partial<LiveAgentSessionPresenceReaderDeps> = {}
): LiveAgentSessionPresenceReaderDeps {
  return {
    listHookRows: () => rows,
    isObservedInCurrentRuntime: () => true,
    resolveIdentityKey: async ({ agent, providerSession }) =>
      `${agent}:${providerSession.key}:${providerSession.id}`,
    getBoundPtyIdForPaneKey: (paneKey) => `pty-${paneKey}`,
    getPersistedPtyIdForPaneKey: () => undefined,
    probePtyLiveness: async () => true,
    ...overrides
  }
}

const subject = { agent: 'claude' as const, providerSession: SESSION, worktreeId: 'worktree-2' }

describe('readLiveAgentSessionPresence', () => {
  it('finds the pane that owns the same provider session', async () => {
    const result = await readLiveAgentSessionPresence(
      deps([
        row('tab-a:leaf'),
        row('tab-b:leaf', { providerSession: { key: 'session_id', id: 'other' } })
      ]),
      { subject, requestingPaneKey: 'tab-z:leaf' }
    )

    expect(result.kind).toBe('live-elsewhere')
    expect(result.liveElsewhere).toEqual(['tab-a:leaf'])
  })

  it('names the runtime behind each live owner so a replacement in the same pane is visible', async () => {
    const result = await readLiveAgentSessionPresence(
      deps([row('tab-a:leaf'), row('tab-c:leaf')], {
        getBoundPtyIdForPaneKey: (paneKey) => (paneKey === 'tab-a:leaf' ? 'pty-a-2' : 'pty-c'),
        probePtyLiveness: async (ptyId) => ptyId !== 'pty-c'
      }),
      { subject, requestingPaneKey: 'tab-z:leaf' }
    )

    expect(result.liveElsewhere).toEqual(['tab-a:leaf'])
    expect(result.incarnationByPane).toEqual({ 'tab-a:leaf': 'pty-a-2' })
  })

  it('never matches on anything but identity: same agent, worktree and cwd, other session', async () => {
    const result = await readLiveAgentSessionPresence(
      deps([
        row('tab-a:leaf', { providerSession: { key: 'session_id', id: 'b' } }),
        row('tab-b:leaf', { providerSession: { key: 'session_id', id: 'c' } })
      ]),
      { subject: { ...subject, worktreeId: 'worktree-1' }, requestingPaneKey: 'tab-z:leaf' }
    )

    expect(result.kind).toBe('no-live-owner')
  })

  it('does not match a different agent reporting the same raw id', async () => {
    const result = await readLiveAgentSessionPresence(
      deps([row('tab-a:leaf', { agentType: 'codex' })]),
      {
        subject,
        requestingPaneKey: 'tab-z:leaf'
      }
    )

    expect(result.kind).toBe('no-live-owner')
  })

  it('skips rows that carry no provider session', async () => {
    const result = await readLiveAgentSessionPresence(
      deps([row('tab-a:leaf', { providerSession: undefined })]),
      { subject, requestingPaneKey: 'tab-z:leaf' }
    )

    expect(result.kind).toBe('no-live-owner')
  })

  it('does not call a same-raw-id pane different when its namespace cannot be resolved', async () => {
    const result = await readLiveAgentSessionPresence(
      deps([row('tab-a:leaf', { worktreeId: 'ssh-worktree' })], {
        resolveIdentityKey: async ({ worktreeId, agent, providerSession }) =>
          worktreeId === 'ssh-worktree' ? null : `${agent}:${providerSession.id}`
      }),
      { subject, requestingPaneKey: 'tab-z:leaf' }
    )

    expect(result.kind).toBe('unknown')
    expect(result.unknown).toEqual(['tab-a:leaf'])
  })

  it('treats a subject whose own identity cannot be resolved as undetermined everywhere', async () => {
    const result = await readLiveAgentSessionPresence(
      deps([row('tab-a:leaf')], { resolveIdentityKey: async () => null }),
      { subject, requestingPaneKey: 'tab-z:leaf' }
    )

    expect(result.kind).toBe('unknown')
  })

  it('treats a row hydrated from disk as dormant when no process is bound', async () => {
    const result = await readLiveAgentSessionPresence(
      deps([row('tab-a:leaf')], {
        isObservedInCurrentRuntime: () => false,
        getBoundPtyIdForPaneKey: () => undefined
      }),
      { subject, requestingPaneKey: 'tab-z:leaf' }
    )

    expect(result.kind).toBe('no-live-owner')
    expect(result.unknown).toEqual([])
  })

  it('probes the persisted PTY of a hydrated row not yet reattached', async () => {
    const probePtyLiveness = vi.fn(async () => true)
    const result = await readLiveAgentSessionPresence(
      deps([row('tab-a:leaf')], {
        isObservedInCurrentRuntime: () => false,
        getBoundPtyIdForPaneKey: () => undefined,
        getPersistedPtyIdForPaneKey: () => 'pty-persisted',
        probePtyLiveness
      }),
      { subject, requestingPaneKey: 'tab-z:leaf' }
    )

    expect(probePtyLiveness).toHaveBeenCalledWith('pty-persisted')
    expect(result.kind).toBe('unknown')
  })

  it('maps a proven-dead PTY to stale', async () => {
    const result = await readLiveAgentSessionPresence(
      deps([row('tab-a:leaf')], { probePtyLiveness: async () => false }),
      { subject, requestingPaneKey: 'tab-z:leaf' }
    )

    expect(result.kind).toBe('no-live-owner')
    expect(result.stale).toEqual(['tab-a:leaf'])
  })

  it('maps an unanswerable or throwing probe to unknown, never to absent', async () => {
    const nullProbe = await readLiveAgentSessionPresence(
      deps([row('tab-a:leaf')], { probePtyLiveness: async () => null }),
      { subject, requestingPaneKey: 'tab-z:leaf' }
    )
    const throwingProbe = await readLiveAgentSessionPresence(
      deps([row('tab-a:leaf')], {
        probePtyLiveness: async () => {
          throw new Error('daemon unreachable')
        }
      }),
      { subject, requestingPaneKey: 'tab-z:leaf' }
    )

    expect(nullProbe.kind).toBe('unknown')
    expect(throwingProbe.kind).toBe('unknown')
    expect(throwingProbe.stale).toEqual([])
  })

  it('does not trust a probe whose pane was rebound while it ran', async () => {
    let bound = 'pty-old'
    const result = await readLiveAgentSessionPresence(
      deps([row('tab-a:leaf')], {
        getBoundPtyIdForPaneKey: () => bound,
        probePtyLiveness: async () => {
          bound = 'pty-new'
          return false
        }
      }),
      { subject, requestingPaneKey: 'tab-z:leaf' }
    )

    expect(result.kind).toBe('unknown')
    expect(result.stale).toEqual([])
  })

  it('sees an owner in another project because identity is not scoped to a worktree', async () => {
    const { createEphemeralAgentSessionClaimSigner } =
      await import('../runtime/agent-session-claim-identity')
    const { agentSessionClaimKey } = await import('../../shared/claimed-agent-pty-owner-snapshot')
    const signer = createEphemeralAgentSessionClaimSigner('runtime-under-test')
    const namespace = {
      machine: 'native:win32',
      principal: 'user:u',
      container: 'native',
      providerRoot: 'profile-default:claude'
    }
    const result = await readLiveAgentSessionPresence(
      deps([row('tab-a:leaf', { worktreeId: 'project-a-worktree' })], {
        resolveIdentityKey: async ({ worktreeId, agent, providerSession }) =>
          agentSessionClaimKey(
            signer.createClaim({
              namespace,
              identity: { agent: agent as 'claude', providerSession },
              canonicalWorktreeId: worktreeId
            })
          )
      }),
      {
        subject: { ...subject, worktreeId: 'project-b-worktree' },
        requestingPaneKey: 'tab-z:leaf'
      }
    )

    expect(result.kind).toBe('live-elsewhere')
    expect(result.liveElsewhere).toEqual(['tab-a:leaf'])
  })

  it('resolves each distinct identity once even with many rows', async () => {
    const resolveIdentityKey = vi.fn(async () => 'same-key')
    await readLiveAgentSessionPresence(
      deps([row('tab-a:leaf'), row('tab-b:leaf'), row('tab-c:leaf')], { resolveIdentityKey }),
      { subject, requestingPaneKey: 'tab-z:leaf' }
    )

    // Why: one call for the subject plus one per distinct (worktree, identity) pair.
    expect(resolveIdentityKey).toHaveBeenCalledTimes(2)
  })
})
