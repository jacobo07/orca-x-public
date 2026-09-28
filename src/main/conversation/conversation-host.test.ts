import { describe, expect, it, vi } from 'vitest'

import type { AgentTurnEvent } from '../../shared/agent-turn-event'
import type { Agent } from '../../shared/agent-types'
import type { ConversationSummary } from '../../shared/conversation-summary'
import type { Project } from '../../shared/project-types'
import {
  createConversationHost,
  type ConversationHostDeps,
  type ConversationTurnEventListener
} from './conversation-host'

const AGENT = { id: 'agent_a', name: 'Ledger', role: 'reviewer', projectId: 'proj_1' } as Agent
const PROJECT = { id: 'proj_1', displayName: 'Ledger repo' } as Project
const SUMMARY = {
  outcome: 'ok',
  id: 'conv_1',
  title: 'First',
  updatedAt: 10,
  agentId: 'agent_a',
  lastTurnState: 'completed'
} as unknown as ConversationSummary

function deps(overrides: Partial<ConversationHostDeps> = {}): ConversationHostDeps {
  const listeners = new Set<ConversationTurnEventListener>()
  return {
    list: vi.fn(async () => [SUMMARY]),
    read: vi.fn(async () => ({ outcome: 'absent' }) as never),
    agentGrounding: vi.fn(async () => ({ outcome: 'agent-missing' }) as never),
    createForAgent: vi.fn(async () => ({ outcome: 'agent-missing' }) as never),
    sendTurn: vi.fn(async () => ({ outcome: 'completed' }) as never),
    readAgents: () => [AGENT],
    readProjects: () => [PROJECT],
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    ...overrides,
    // exposed for the stream test
    ...({ __listeners: listeners } as object)
  }
}

describe('createConversationHost', () => {
  it('never lets a remote caller choose where a turn runs', async () => {
    const d = deps()
    const host = createConversationHost(d)

    // A caller that smuggles a cwd past the type still reaches the turn with none.
    await host.sendTurn({ id: 'conv_1', text: 'hi', cwd: '/etc' } as never)

    expect(d.sendTurn).toHaveBeenCalledWith({ id: 'conv_1', text: 'hi', cwd: null })
  })

  it('projects the roster with the shared projection: the thread is in its AGENT project', async () => {
    const host = createConversationHost(deps())

    const workspace = await host.readWorkspace()

    expect(workspace.agents[0]?.project).toEqual({
      kind: 'project',
      projectId: 'proj_1',
      displayName: 'Ledger repo'
    })
    expect(workspace.agents[0]?.threadCount).toBe(1)
    const thread = workspace.threads[0]
    expect(thread?.outcome).toBe('ok')
    expect(thread && thread.outcome === 'ok' ? thread.project : null).toEqual({
      kind: 'project',
      projectId: 'proj_1',
      displayName: 'Ledger repo'
    })
  })

  it('streams only the subscribed conversation, and stops on unsubscribe', () => {
    const d = deps()
    const listeners = (d as unknown as { __listeners: Set<ConversationTurnEventListener> })
      .__listeners
    const host = createConversationHost(d)
    const seen: AgentTurnEvent[] = []
    const event = { type: 'turn-started' } as unknown as AgentTurnEvent

    const stop = host.subscribeTurnEvents('conv_1', (e) => seen.push(e))
    for (const listener of listeners) {
      listener({ conversationId: 'conv_other', event })
      listener({ conversationId: 'conv_1', event })
    }
    stop()
    for (const listener of listeners) {
      listener({ conversationId: 'conv_1', event })
    }

    expect(seen).toEqual([event])
    expect(listeners.size).toBe(0)
  })
})
