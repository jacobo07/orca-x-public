// Drives the REAL handlers against a REAL store on disk. The point of this file is the chain:
// a handler that returned a plausible object without the record reaching disk would satisfy any
// assertion made on its return value alone, so every case here reads back through a second service.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { mintAgentId } from '../../shared/agent-identity'
import type { AgentTurnEvent } from '../../shared/agent-turn-event'
import type { Agent } from '../../shared/agent-types'
import { mintConversationId } from '../../shared/conversation-identity'
import { ConversationService } from '../conversation/conversation-service'
import type { ConversationTurnDeps } from '../conversation/conversation-turn-runner'

import { createConversationIpcHandlers, type ConversationIpcHandlers } from './conversations'

let root = ''
let handlers: ConversationIpcHandlers
let readerService: ConversationService
let emitted: { conversationId: string; event: AgentTurnEvent }[] = []
let authReady = true
let roster: Agent[] = []

function build(overrides: Partial<Omit<ConversationTurnDeps, 'service'>> = {}): void {
  const directory = (): string => join(root, 'conversations')
  emitted = []
  handlers = createConversationIpcHandlers({
    service: new ConversationService(directory, { readAgents: () => roster }),
    turnDeps: {
      driver: {
        runTurn: async (request) => {
          request.onEvent({ kind: 'turn-started', turnId: request.turnId })
          request.onEvent({
            kind: 'message-completed',
            turnId: request.turnId,
            itemId: 'item-1',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'an answer' }]
          })
          request.onEvent({ kind: 'turn-completed', turnId: request.turnId })
          return { providerSessionId: 'thread-1' }
        }
      },
      checkAuth: async () =>
        authReady ? { ready: true } : { ready: false, detail: 'codex credential is missing' },
      mintTurnId: () => 'turn-1',
      mintItemId: () => 'user-item-1',
      emit: (conversationId, event) => emitted.push({ conversationId, event }),
      ...overrides
    }
  })
  readerService = new ConversationService(directory)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-conv-ipc-'))
  authReady = true
  build()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('conversation IPC handlers', () => {
  it('exposes exactly the product operations, and no storage primitive', () => {
    // Named explicitly rather than counted: a `toHaveLength(4)` would stay green if `read` were
    // swapped for `writeFile`, which is the exact mistake this boundary exists to prevent.
    expect(Object.keys(handlers).sort()).toEqual([
      'conversations:create',
      'conversations:createForAgent',
      'conversations:list',
      'conversations:read',
      'conversations:sendTurn'
    ])
  })

  it('creates a conversation that a separate reader can load from disk', async () => {
    const created = await handlers['conversations:create']({ title: 'first chat' })

    const loaded = await readerService.read(created.id)
    expect(loaded.outcome).toBe('loaded')
    if (loaded.outcome !== 'loaded') {
      throw new Error('unreachable')
    }
    expect(loaded.record.title).toBe('first chat')
  })

  it('lists what was created, through the handler rather than the service', async () => {
    const created = await handlers['conversations:create']({ title: 'listed' })

    const rows = await handlers['conversations:list']()
    expect(rows.map((row) => row.id)).toEqual([created.id])
    expect(rows[0].outcome).toBe('ok')
  })

  it('reads a conversation and answers an outcome, not an exception, when it is absent', async () => {
    const created = await handlers['conversations:create']({})
    expect((await handlers['conversations:read']({ id: created.id })).outcome).toBe('loaded')

    // A well-formed id for a conversation that is not here is a normal product state.
    const absent = await handlers['conversations:read']({ id: mintConversationId() })
    expect(absent.outcome).toBe('absent')
  })

  it('refuses a value that is not a conversation id instead of reporting corrupt data', async () => {
    // Loud, because this is a renderer bug. Folding it into `unreadable` would tell the user their
    // conversation is damaged when the defect is ours.
    await expect(handlers['conversations:read']({ id: '../../etc/passwd' })).rejects.toThrow(
      /not a conversation id/
    )
    await expect(handlers['conversations:read']({ id: '' })).rejects.toThrow(/not a conversation id/)
  })

  it('does not invent a project binding when the renderer sends none', async () => {
    const created = await handlers['conversations:create']({ title: 'unbound' })
    expect(created.projectId).toBeNull()
  })
})

describe('conversation IPC — creating a conversation with an agent', () => {
  beforeEach(() => {
    roster = []
  })

  it('binds the agent, and a separate reader sees the binding on disk', async () => {
    const agentId = mintAgentId()
    roster.push({ id: agentId, name: 'Ada', role: 'r', projectId: null, createdAt: 1, updatedAt: 1 })

    const created = await handlers['conversations:createForAgent']({ agentId, title: 'hello' })
    if (created.outcome !== 'created') throw new Error(`precondition: ${created.outcome}`)

    const loaded = await readerService.read(created.record.id)
    expect(loaded.outcome === 'loaded' && loaded.record.agentId).toBe(agentId)
  })

  it('answers an outcome for an agent that is not in the roster', async () => {
    const agentId = mintAgentId()
    expect(await handlers['conversations:createForAgent']({ agentId })).toEqual({
      outcome: 'agent-not-found',
      agentId
    })
  })

  it('throws on a value that is not an agent id — a renderer defect, not the user’s data', async () => {
    await expect(
      handlers['conversations:createForAgent']({ agentId: 'conv_nope' })
    ).rejects.toThrow(/not an agent id/)
  })

  // The agent path has no project parameter. A renderer that sends one anyway cannot plant it.
  it('ignores a project a renderer tries to smuggle onto an agent-bound create', async () => {
    const agentId = mintAgentId()
    roster.push({ id: agentId, name: 'Ada', role: 'r', projectId: 'repo:a', createdAt: 1, updatedAt: 1 })

    const created = await handlers['conversations:createForAgent']({
      agentId,
      projectId: 'repo:b'
    } as never)
    expect(created.outcome === 'created' && created.record.projectId).toBeNull()
  })
})

describe('conversation IPC — sending a turn', () => {
  it('runs a turn end to end and leaves the exchange on disk', async () => {
    const created = await handlers['conversations:create']({})
    const outcome = await handlers['conversations:sendTurn']({
      id: created.id,
      text: 'what should we build?',
      cwd: root
    })

    expect(outcome).toEqual({
      outcome: 'completed',
      turnId: 'turn-1',
      providerSessionId: 'thread-1'
    })

    const loaded = await readerService.read(created.id)
    if (loaded.outcome !== 'loaded') {
      throw new Error(`expected loaded, got ${loaded.outcome}`)
    }
    expect(loaded.record.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
  })

  it('streams the turn to the surface as it happens', async () => {
    const created = await handlers['conversations:create']({})
    await handlers['conversations:sendTurn']({ id: created.id, text: 'hi', cwd: root })

    expect(emitted.every((entry) => entry.conversationId === created.id)).toBe(true)
    expect(emitted.map((entry) => entry.event.kind)).toEqual([
      'turn-started',
      'message-completed',
      'turn-completed'
    ])
  })

  it('reports an unauthenticated provider as its own state, not as an empty answer', async () => {
    authReady = false
    const created = await handlers['conversations:create']({})
    const outcome = await handlers['conversations:sendTurn']({
      id: created.id,
      text: 'hello',
      cwd: root
    })

    expect(outcome).toEqual({ outcome: 'auth-required', detail: 'codex credential is missing' })

    const loaded = await readerService.read(created.id)
    if (loaded.outcome !== 'loaded') {
      throw new Error(`expected loaded, got ${loaded.outcome}`)
    }
    // The user's words survived; no assistant message was fabricated.
    expect(loaded.record.messages).toHaveLength(1)
    expect(loaded.record.messages[0].role).toBe('user')
  })

  it('refuses an empty turn rather than sending one', async () => {
    const created = await handlers['conversations:create']({})
    await expect(
      handlers['conversations:sendTurn']({ id: created.id, text: '   ', cwd: root })
    ).rejects.toThrow(/needs text/)
  })
})
