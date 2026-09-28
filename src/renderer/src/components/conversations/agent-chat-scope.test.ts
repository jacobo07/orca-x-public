import { describe, expect, it } from 'vitest'

import type { ConversationSummary } from '../../../../shared/conversation-summary'

import { conversationsInScope, latestConversationForAgent } from './agent-chat-scope'

function row(id: string, agentId: string | null, updatedAt: number): ConversationSummary {
  return {
    outcome: 'ok',
    id,
    title: id,
    createdAt: 1,
    updatedAt,
    projectId: null,
    agentId,
    messageCount: 1,
    lastTurnState: null
  }
}

const corrupt: ConversationSummary = { outcome: 'unreadable', id: 'conv_bad', reason: 'torn' }
const newestFirst = [
  row('conv_ada2', 'agent_ada', 30),
  row('conv_free', null, 20),
  row('conv_mo', 'agent_mo', 15),
  row('conv_ada1', 'agent_ada', 10),
  corrupt
]

describe('conversationsInScope', () => {
  it('shows an agent only its own conversations', () => {
    expect(conversationsInScope(newestFirst, 'agent_ada').map((s) => s.id)).toEqual([
      'conv_ada2',
      'conv_ada1'
    ])
  })

  it('keeps agent chats out of Brainstorming, and keeps unreadable rows in it', () => {
    expect(conversationsInScope(newestFirst, null).map((s) => s.id)).toEqual([
      'conv_free',
      'conv_bad'
    ])
  })
})

describe('latestConversationForAgent', () => {
  it('opens the agent’s most recent conversation', () => {
    expect(latestConversationForAgent(newestFirst, 'agent_ada')).toBe('conv_ada2')
  })

  it('starts a draft for an agent nobody has talked to yet', () => {
    expect(latestConversationForAgent(newestFirst, 'agent_new')).toBeNull()
  })
})
