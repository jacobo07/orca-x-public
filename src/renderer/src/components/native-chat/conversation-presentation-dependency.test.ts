// Characterization of the defect W1 exists to remove: today a "conversation" is not an entity.
// It is a lookup through the live presentation, so the pane IS the conversation's identity and its
// reachability. These assertions pin CURRENT behaviour — when the Orca-owned conversation primitive
// lands, the pane layer keeps behaving exactly like this (it is a pane resolver, and that is
// correct for a pane resolver); what changes is that it stops being the ONLY way to reach a
// conversation. This file is the evidence of the starting state, so the diff against the
// conversation gates is readable.
//
// Discriminating by construction: every assertion below fails if the pane dependency is removed
// here instead of being layered over, which is the wrong fix and the one worth catching.
import { describe, expect, it } from 'vitest'

import type { AgentStatusEntry } from '../../../../shared/agent-status-types'

import { resolveNativeChatSession } from './native-chat-pane-resolution'

const PANE_KEY = 'tab-1:1f2e3d4c-5b6a-7980-1234-56789abcdef0'

function liveEntry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'working',
    prompt: 'ORCA_W1',
    updatedAt: 1_000,
    stateStartedAt: 1_000,
    agentType: 'claude',
    paneKey: PANE_KEY,
    providerSession: {
      id: 'provider-session-alpha',
      transcriptPath: '/transcripts/alpha.jsonl'
    },
    ...overrides
  } as AgentStatusEntry
}

describe('conversation identity today is a lookup through the presentation', () => {
  it('resolves a conversation only while the pane is live', () => {
    const resolved = resolveNativeChatSession({
      paneKey: PANE_KEY,
      agentStatusEntry: liveEntry(),
      ptyId: 'pty-1'
    })

    expect(resolved).not.toBeNull()
    expect(resolved?.paneKey).toBe(PANE_KEY)
    expect(resolved?.sessionId).toBe('provider-session-alpha')
  })

  // The defect, stated as an observation: destroy the presentation and the conversation does not
  // become detached — it stops existing. There is no id left to ask about it with.
  it('loses the conversation entirely once the presentation is gone', () => {
    const afterPaneDestroyed = resolveNativeChatSession({
      paneKey: PANE_KEY,
      agentStatusEntry: undefined,
      launchAgent: null,
      resolvedAgent: null,
      ptyId: null
    })

    expect(afterPaneDestroyed).toBeNull()
  })

  // Identity is the PROVIDER's session id, not Orca's. So provider session rotation — which the
  // provider may do for reasons of its own — reads downstream as a different conversation.
  it('changes conversation identity when the provider rotates its session', () => {
    const before = resolveNativeChatSession({
      paneKey: PANE_KEY,
      agentStatusEntry: liveEntry(),
      ptyId: 'pty-1'
    })
    const after = resolveNativeChatSession({
      paneKey: PANE_KEY,
      agentStatusEntry: liveEntry({
        providerSession: { id: 'provider-session-beta', transcriptPath: '/transcripts/beta.jsonl' }
      } as Partial<AgentStatusEntry>),
      ptyId: 'pty-1'
    })

    expect(before?.sessionId).toBe('provider-session-alpha')
    expect(after?.sessionId).toBe('provider-session-beta')
    expect(after?.sessionId).not.toBe(before?.sessionId)
  })

  // Before the agent has reported a session there is no identity at all, so a conversation that has
  // been typed into but not yet acknowledged by the provider cannot be named, let alone persisted.
  it('has no identity before the provider reports one', () => {
    const resolved = resolveNativeChatSession({
      paneKey: PANE_KEY,
      launchAgent: 'claude',
      ptyId: 'pty-1'
    })

    expect(resolved).not.toBeNull()
    expect(resolved?.sessionId).toBeNull()
  })
})
