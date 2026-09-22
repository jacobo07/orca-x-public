import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { mintAgentId } from '../../shared/agent-identity'
import type { Agent } from '../../shared/agent-types'
import type { ConversationId, ConversationRecord } from '../../shared/conversation-types'

import { ConversationService } from './conversation-service'
import {
  runConversationTurn,
  type ConversationTurnDeps,
  type ProviderTurnRequest
} from './conversation-turn-runner'

// An agent chat differs from Brainstorming only if the agent reaches the provider. These cases
// observe the provider-neutral envelope the runner hands the driver — the boundary where a role
// either becomes behaviour or stays a label — rather than judging the model's wording.

let root = ''
let roster: Agent[] = []
let service: ConversationService
let driverCalls: ProviderTurnRequest[] = []
let counter = 0
let echoUser = false

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-agent-turn-'))
  roster = []
  service = new ConversationService(() => join(root, 'conversations'), {
    readAgents: () => roster
  })
  driverCalls = []
  counter = 0
  echoUser = false
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function agent(name: string, role: string): Agent {
  const created = { id: mintAgentId(), name, role, projectId: null, createdAt: 1, updatedAt: 1 }
  roster.push(created)
  return created
}

function deps(): ConversationTurnDeps {
  return {
    service,
    driver: {
      runTurn: async (request) => {
        driverCalls.push(request)
        request.onEvent({ kind: 'turn-started', turnId: request.turnId })
        if (echoUser) {
          // The real codex app-server reports the prompt back under ITS id.
          request.onEvent({
            kind: 'message-completed',
            turnId: request.turnId,
            itemId: `provider-echo-${counter}`,
            role: 'user',
            blocks: [{ type: 'text', text: request.text }]
          })
        }
        request.onEvent({
          kind: 'message-completed',
          turnId: request.turnId,
          itemId: `answer-${++counter}`,
          role: 'assistant',
          blocks: [{ type: 'text', text: 'ok' }]
        })
        request.onEvent({ kind: 'turn-completed', turnId: request.turnId })
        return { providerSessionId: 'thread-1' }
      }
    },
    checkAuth: async () => ({ ready: true }),
    // Every agent in this file owns no project, so location never overrides the caller's cwd and
    // these cases keep measuring exactly what they measured before: the instruction envelope.
    resolveProjectLocation: () => ({ outcome: 'no-project' }),
    fallbackCwd: () => root,
    mintTurnId: () => `turn-${++counter}`,
    mintItemId: () => `user-${++counter}`,
    emit: () => {}
  }
}

async function send(id: ConversationId, text: string) {
  return runConversationTurn(deps(), { conversationId: id, text, cwd: root })
}

async function settled(id: ConversationId): Promise<ConversationRecord> {
  await service.applyEvent(id, (record) => record)
  const loaded = await service.read(id)
  if (loaded.outcome !== 'loaded') throw new Error(`expected loaded, got ${loaded.outcome}`)
  return loaded.record
}

async function chatWith(target: Agent): Promise<ConversationId> {
  const created = await service.createForAgent({ agentId: target.id, title: target.name })
  if (created.outcome !== 'created') throw new Error(`precondition: ${created.outcome}`)
  return created.record.id
}

describe('an agent reaches the provider-neutral turn', () => {
  it('gives two agents with different roles two different envelopes', async () => {
    const ada = agent('Ada', 'Reviews migrations for data loss.')
    const mo = agent('Mo', 'Writes release notes for customers.')

    await send(await chatWith(ada), 'hi')
    await send(await chatWith(mo), 'hi')

    const [first, second] = driverCalls.map((call) => call.developerInstructions)
    expect(first).toContain('Reviews migrations for data loss.')
    expect(second).toContain('Writes release notes for customers.')
    expect(first).not.toEqual(second)
  })

  it('sends no instructions for a Brainstorming conversation', async () => {
    const created = await service.create({ title: 'no one' })
    await send(created.id, 'hi')
    expect(driverCalls[0].developerInstructions).toBeNull()
  })

  it('refuses a turn whose agent is gone, before committing or spending anything', async () => {
    const ada = agent('Ada', 'r')
    const id = await chatWith(ada)
    roster.length = 0

    expect(await send(id, 'are you there?')).toEqual({
      outcome: 'agent-unavailable',
      agentId: ada.id,
      reason: 'missing'
    })
    expect(driverCalls).toHaveLength(0)
    expect((await settled(id)).messages).toHaveLength(0)
  })
})

describe('an agent chat across turns', () => {
  it('continues the same thread, keeps the agent, and stores each user message once', async () => {
    const ada = agent('Ada', 'Reviews migrations for data loss.')
    const id = await chatWith(ada)
    echoUser = true

    expect((await send(id, 'first')).outcome).toBe('completed')
    expect((await send(id, 'second')).outcome).toBe('completed')

    expect(driverCalls.map((call) => call.resumeSessionId)).toEqual([null, 'thread-1'])
    expect(driverCalls[1].developerInstructions).toContain('Reviews migrations for data loss.')

    const record = await settled(id)
    expect(record.agentId).toBe(ada.id)
    const userTexts = record.messages
      .filter((message) => message.role === 'user')
      .map((message) => message.blocks)
    expect(userTexts).toEqual([
      [{ type: 'text', text: 'first' }],
      [{ type: 'text', text: 'second' }]
    ])
    // The provider thread is provenance, never the agent's identity.
    expect(record.provenance.map((entry) => entry.providerSessionId)).toEqual(['thread-1'])
  })

  it('uses the role as it is now, without rewriting what was already said', async () => {
    const ada = agent('Ada', 'Old focus.')
    const id = await chatWith(ada)
    await send(id, 'before')

    roster[0] = { ...ada, role: 'New focus.' }
    await send(id, 'after')

    expect(driverCalls[1].developerInstructions).toContain('New focus.')
    expect(driverCalls[1].developerInstructions).not.toContain('Old focus.')
    const first = (await settled(id)).messages.find((message) => message.role === 'user')
    expect(first?.blocks).toEqual([{ type: 'text', text: 'before' }])
  })
})

// The compiler's own cases live in agent-turn-instructions.test.ts, beside what they test, rather
// than in two places: a looser duplicate can satisfy the stricter copy's subject and disarm the
// drill that proves the stricter one still works.
