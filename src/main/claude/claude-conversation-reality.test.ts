// Opt-in: drives the PRODUCTION Claude driver and turn runner against the real `claude` binary.
// Costs real quota, so it runs only with ORCA_CLAUDE_REALITY=1. Two turns: the second must recall a
// word only the first turn contained, which is only possible if `--resume` continued the session.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ConversationService } from '../conversation/conversation-service'
import { runConversationTurn, type ConversationTurnDeps } from '../conversation/conversation-turn-runner'
import { createClaudeConversationDriver } from './claude-conversation-driver'
import { checkClaudeAuth } from './claude-auth-readiness'
import type { ClaudeQuotaObservation } from './claude-stream-mapping'

const ENABLED = process.env.ORCA_CLAUDE_REALITY === '1'
const WORD = `heliotrope-${Date.now().toString(36)}`

describe.skipIf(!ENABLED)('claude driver against the real provider', () => {
  let root = ''
  let service: ConversationService
  const quotas: ClaudeQuotaObservation[] = []
  let turn = 0

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-claude-reality-'))
    service = new ConversationService(() => join(root, 'conversations'))
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function deps(): ConversationTurnDeps {
    return {
      service,
      driver: createClaudeConversationDriver({ observeQuota: (quota) => quotas.push(quota) }),
      checkAuth: () => checkClaudeAuth(),
      resolveProjectLocation: () => ({ outcome: 'no-project' }),
      // A scratch directory with no project settings: the run loads none of the user's hooks.
      fallbackCwd: () => root,
      mintTurnId: () => `turn-${++turn}`,
      mintItemId: () => `item-${turn}`,
      emit: () => {}
    }
  }

  async function lastReply(conversationId: string): Promise<string> {
    const loaded = await service.read(conversationId)
    if (loaded.outcome !== 'loaded') {
      throw new Error(loaded.outcome)
    }
    const message = loaded.record.messages.filter((entry) => entry.role === 'assistant').at(-1)
    return (message?.blocks ?? []).map((block) => (block.type === 'text' ? block.text : '')).join('')
  }

  it('answers, records its own session, and continues that session on the next turn', async () => {
    const conversation = await service.create({})

    const first = await runConversationTurn(deps(), {
      conversationId: conversation.id,
      text: `Remember this word for later: ${WORD}. Reply only with: noted`,
      cwd: null
    })
    expect(first).toMatchObject({ outcome: 'completed' })
    const afterFirst = await service.read(conversation.id)
    const session = afterFirst.outcome === 'loaded' ? afterFirst.record.provenance.at(-1) : undefined
    expect(session).toMatchObject({ agent: 'claude' })
    expect(session?.providerSessionId).toMatch(/^[0-9a-f-]{36}$/)

    const second = await runConversationTurn(deps(), {
      conversationId: conversation.id,
      text: 'What was the word I asked you to remember? Reply with the word only.',
      cwd: null
    })
    expect(second).toMatchObject({ outcome: 'completed' })
    expect(await lastReply(conversation.id)).toContain(WORD)
    expect(quotas.length).toBeGreaterThan(0)
  }, 240_000)
})
