import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AgentTurnEvent } from '../../shared/agent-turn-event'
import type { ConversationId, ConversationRecord } from '../../shared/conversation-types'

import { ConversationService } from './conversation-service'
import {
  runConversationTurn,
  type ConversationTurnDeps,
  type ProviderTurnRequest
} from './conversation-turn-runner'

let root = ''
let service: ConversationService
let emitted: AgentTurnEvent[] = []
let driverCalls: ProviderTurnRequest[] = []
let turnCounter = 0
let itemCounter = 0

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-turn-runner-'))
  service = new ConversationService(() => join(root, 'conversations'))
  emitted = []
  driverCalls = []
  turnCounter = 0
  itemCounter = 0
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Queues behind every append already in flight for this conversation, so a test observes the
 *  record only after the runner's fire-and-forget event writes have settled. Uses the real
 *  serialization rather than a timer, which would be a guess about how long the queue takes. */
async function flush(id: ConversationId): Promise<ConversationRecord> {
  await service.applyEvent(id, (record) => record)
  const loaded = await service.read(id)
  if (loaded.outcome !== 'loaded') {
    throw new Error(`expected loaded, got ${loaded.outcome}`)
  }
  return loaded.record
}

function deps(overrides: Partial<ConversationTurnDeps> = {}): ConversationTurnDeps {
  return {
    service,
    driver: {
      runTurn: async (request) => {
        driverCalls.push(request)
        request.onEvent({ kind: 'turn-started', turnId: request.turnId })
        request.onEvent({
          kind: 'assistant-delta',
          turnId: request.turnId,
          itemId: 'item-a',
          text: 'par'
        })
        request.onEvent({
          kind: 'assistant-delta',
          turnId: request.turnId,
          itemId: 'item-a',
          text: 'tial'
        })
        request.onEvent({
          kind: 'message-completed',
          turnId: request.turnId,
          itemId: 'item-a',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'partial answer' }]
        })
        request.onEvent({ kind: 'turn-completed', turnId: request.turnId })
        return { providerSessionId: 'thread-1' }
      }
    },
    checkAuth: async () => ({ ready: true }),
    mintTurnId: () => `turn-${++turnCounter}`,
    mintItemId: () => `user-item-${++itemCounter}`,
    emit: (_id, event) => {
      emitted.push(event)
    },
    ...overrides
  }
}

describe('runConversationTurn — the happy path', () => {
  it('commits the user message, streams, and persists only the settled result', async () => {
    const created = await service.create({})
    const outcome = await runConversationTurn(deps(), {
      conversationId: created.id,
      text: 'what should we build?',
      cwd: root
    })

    expect(outcome).toEqual({
      outcome: 'completed',
      turnId: 'turn-1',
      providerSessionId: 'thread-1'
    })

    const record = await flush(created.id)
    expect(record.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(record.turns).toHaveLength(1)
    expect(record.turns[0].state).toBe('completed')
    expect(record.turns[0].endedAt).not.toBeNull()
  })

  it('does not write a durable message per token', async () => {
    const created = await service.create({})
    await runConversationTurn(deps(), { conversationId: created.id, text: 'hi', cwd: root })

    const record = await flush(created.id)
    // Two deltas were emitted live; neither may become a message. Persisting them would rewrite
    // the same sentence repeatedly and make an interrupted turn look finished.
    expect(emitted.filter((event) => event.kind === 'assistant-delta')).toHaveLength(2)
    expect(record.messages).toHaveLength(2)
  })

  it('records the provider thread as provenance, not as identity', async () => {
    const created = await service.create({})
    await runConversationTurn(deps(), { conversationId: created.id, text: 'hi', cwd: root })

    const record = await flush(created.id)
    expect(record.id).toBe(created.id)
    expect(record.provenance).toEqual([
      expect.objectContaining({ agent: 'codex', providerSessionId: 'thread-1' })
    ])
  })

  it('resumes the recorded thread on the next turn instead of starting a second one', async () => {
    const created = await service.create({})
    await runConversationTurn(deps(), { conversationId: created.id, text: 'first', cwd: root })
    await runConversationTurn(deps(), { conversationId: created.id, text: 'second', cwd: root })

    expect(driverCalls.map((call) => call.resumeSessionId)).toEqual([null, 'thread-1'])
    const record = await flush(created.id)
    // Same binding re-observed: lineage must not grow on every turn.
    expect(record.provenance).toHaveLength(1)
  })
})

describe('runConversationTurn — refusals, in the order that protects the user', () => {
  it('refuses a turn for a conversation that is not there, before spending anything', async () => {
    const outcome = await runConversationTurn(deps(), {
      conversationId: 'conv_missing',
      text: 'hi',
      cwd: root
    })
    expect(outcome).toEqual({ outcome: 'conversation-absent' })
    expect(driverCalls).toHaveLength(0)
  })

  it('refuses a second turn while one is running, without committing its message', async () => {
    const created = await service.create({})
    let releaseFirst = (): void => {}
    const blocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const slow = deps({
      driver: {
        runTurn: async (request) => {
          await blocked
          request.onEvent({ kind: 'turn-completed', turnId: request.turnId })
          return { providerSessionId: 'thread-1' }
        }
      }
    })

    const first = runConversationTurn(slow, {
      conversationId: created.id,
      text: 'first',
      cwd: root
    })
    // Let the first turn reach the driver and hold the slot.
    await new Promise((resolve) => setTimeout(resolve, 20))

    const second = await runConversationTurn(deps(), {
      conversationId: created.id,
      text: 'second',
      cwd: root
    })
    expect(second).toEqual({ outcome: 'busy', activeTurnId: 'turn-1' })

    releaseFirst()
    await first

    const record = await flush(created.id)
    // The refused send left nothing behind: one user message, not two.
    expect(record.messages.filter((message) => message.role === 'user')).toHaveLength(1)
  })

  it('keeps the user message when the provider is not authenticated, and runs no turn', async () => {
    const created = await service.create({})
    const outcome = await runConversationTurn(
      deps({ checkAuth: async () => ({ ready: false, detail: 'codex: no stored credential' }) }),
      { conversationId: created.id, text: 'still mine', cwd: root }
    )

    expect(outcome).toEqual({
      outcome: 'auth-required',
      detail: 'codex: no stored credential'
    })
    // A 401 is not a conversation: no assistant message, and nothing was asked of the provider.
    expect(driverCalls).toHaveLength(0)

    const record = await flush(created.id)
    expect(record.messages).toHaveLength(1)
    expect(record.messages[0].role).toBe('user')
    expect(record.messages.some((message) => message.role === 'assistant')).toBe(false)
  })

  it('reports a crashed provider as failed and leaves no turn reading as finished', async () => {
    const created = await service.create({})
    const outcome = await runConversationTurn(
      deps({
        driver: {
          runTurn: async (request) => {
            request.onEvent({ kind: 'turn-started', turnId: request.turnId })
            throw new Error('provider died')
          }
        }
      }),
      { conversationId: created.id, text: 'hi', cwd: root }
    )

    expect(outcome.outcome).toBe('failed')
    const record = await flush(created.id)
    expect(record.turns).toHaveLength(1)
    expect(record.turns[0].state).toBe('failed')
    expect(record.turns[0].endedAt).not.toBeNull()
  })

  it('refuses to call a turn complete when the provider never settled it', async () => {
    const created = await service.create({})
    const outcome = await runConversationTurn(
      deps({
        driver: {
          runTurn: async (request) => {
            request.onEvent({ kind: 'turn-started', turnId: request.turnId })
            // Returns without turn-completed or turn-ended: the shape a killed child produces.
            return { providerSessionId: null }
          }
        }
      }),
      { conversationId: created.id, text: 'hi', cwd: root }
    )

    expect(outcome.outcome).toBe('failed')
    const record = await flush(created.id)
    expect(record.turns[0].state).toBe('interrupted')
  })

  it('releases the slot after a failure so the conversation is not wedged', async () => {
    const created = await service.create({})
    await runConversationTurn(
      deps({
        driver: {
          runTurn: async () => {
            throw new Error('boom')
          }
        }
      }),
      { conversationId: created.id, text: 'hi', cwd: root }
    )

    expect(service.hasActiveTurn(created.id)).toBe(false)
    const retry = await runConversationTurn(deps(), {
      conversationId: created.id,
      text: 'again',
      cwd: root
    })
    expect(retry.outcome).toBe('completed')
  })
})
