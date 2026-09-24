// A provider session id belongs to the provider that issued it. When a conversation's turns move
// between providers, each provider may only ever be asked to resume its OWN thread.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ConversationService } from './conversation-service'
import {
  runConversationTurn,
  type ConversationTurnDeps,
  type ProviderTurnRequest
} from './conversation-turn-runner'

let root = ''
let service: ConversationService

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-provider-resume-'))
  service = new ConversationService(() => join(root, 'conversations'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function recordingDriver(provider: 'codex' | 'claude', sessionId: string, calls: ProviderTurnRequest[]) {
  return {
    provider,
    runTurn: async (request: ProviderTurnRequest) => {
      calls.push(request)
      request.onEvent({ kind: 'turn-started', turnId: request.turnId })
      request.onEvent({ kind: 'turn-completed', turnId: request.turnId })
      return { providerSessionId: sessionId }
    }
  }
}

function deps(driver: ConversationTurnDeps['driver']): ConversationTurnDeps {
  let turn = 0
  return {
    service,
    driver,
    resolveProjectLocation: () => ({ outcome: 'no-project' }),
    fallbackCwd: () => root,
    checkAuth: async () => ({ ready: true }),
    mintTurnId: () => `turn-${++turn}-${driver.provider}`,
    mintItemId: () => `item-${turn}-${driver.provider}`,
    emit: () => {}
  }
}

describe('provider session resume across providers', () => {
  it('asks each provider to resume only the thread that provider issued', async () => {
    const conversation = await service.create({})
    const codexCalls: ProviderTurnRequest[] = []
    const claudeCalls: ProviderTurnRequest[] = []
    const codex = recordingDriver('codex', 'codex-thread-1', codexCalls)
    const claude = recordingDriver('claude', 'claude-session-1', claudeCalls)

    await runConversationTurn(deps(codex), { conversationId: conversation.id, text: 'one', cwd: null })
    await runConversationTurn(deps(claude), { conversationId: conversation.id, text: 'two', cwd: null })
    await runConversationTurn(deps(codex), { conversationId: conversation.id, text: 'three', cwd: null })
    await runConversationTurn(deps(claude), { conversationId: conversation.id, text: 'four', cwd: null })

    expect(codexCalls.map((call) => call.resumeSessionId)).toEqual([null, 'codex-thread-1'])
    expect(claudeCalls.map((call) => call.resumeSessionId)).toEqual([null, 'claude-session-1'])

    const loaded = await service.read(conversation.id)
    if (loaded.outcome !== 'loaded') {
      throw new Error(loaded.outcome)
    }
    expect(loaded.record.provenance.map((entry) => [entry.agent, entry.providerSessionId])).toEqual([
      ['codex', 'codex-thread-1'],
      ['claude', 'claude-session-1'],
      ['codex', 'codex-thread-1'],
      ['claude', 'claude-session-1']
    ])
  })
})
