import { describe, expect, it } from 'vitest'

import type { AgentTurnEvent } from '../../shared/agent-turn-event'

import { createCodexConversationDriver } from './codex-conversation-driver'
import type { runCodexAppServerSession } from './codex-app-server-session'

type Call = { method: string; params: unknown }
type Notify = (method: string, params: unknown) => void
type Script = (method: string, params: unknown, notify: Notify) => Promise<unknown>

type Captured = { calls: Call[]; command: string | null }

function fakeSession(script: Script, captured: Captured): typeof runCodexAppServerSession {
  return (async (
    invocation: { command: string },
    body: (rpc: { request: (method: string, params: unknown) => Promise<unknown> }) => Promise<unknown>,
    _spawn: unknown,
    handlers?: { onNotification?: (notification: { method: string; params: unknown }) => void }
  ) => {
    captured.command = invocation.command
    const notify: Notify = (method, params) => handlers?.onNotification?.({ method, params })
    return body({
      request: async (method, params) => {
        captured.calls.push({ method, params })
        return script(method, params, notify)
      }
    })
  }) as unknown as typeof runCodexAppServerSession
}

/** Answers like the real peer: thread/* return a thread envelope, and turn/start is acknowledged
 *  while the turn actually advances by notification. */
const completingScript: Script = async (method, _params, notify) => {
  if (method === 'thread/start') {
    return { thread: { id: 'thread-new' } }
  }
  if (method === 'thread/resume') {
    return { thread: { id: 'thread-resumed' } }
  }
  if (method === 'turn/start') {
    notify('turn/started', { turn: { id: 'turn-1' } })
    notify('item/agentMessage/delta', { itemId: 'item-1', delta: 'hel', turnId: 'turn-1' })
    notify('item/agentMessage/delta', { itemId: 'item-1', delta: 'lo', turnId: 'turn-1' })
    notify('item/completed', {
      turnId: 'turn-1',
      item: { id: 'item-1', type: 'agentMessage', text: 'hello' }
    })
    notify('turn/completed', { turn: { id: 'turn-1' } })
    return {}
  }
  return {}
}

function collect(): { events: AgentTurnEvent[]; onEvent: (event: AgentTurnEvent) => void } {
  const events: AgentTurnEvent[] = []
  return { events, onEvent: (event) => events.push(event) }
}

describe('codex conversation driver — starting and resuming', () => {
  it('starts a read-only thread when the conversation has no provider binding', async () => {
    const captured: Captured = { calls: [], command: null }
    const sink = collect()
    const driver = createCodexConversationDriver({
      command: 'codex-test',
      runSession: fakeSession(completingScript, captured)
    })

    const result = await driver.runTurn({
      resumeSessionId: null,
      cwd: '/tmp/work',
      text: 'hello',
      developerInstructions: null,
      turnId: 'turn-1',
      onEvent: sink.onEvent
    })

    expect(captured.command).toBe('codex-test')
    expect(result.providerSessionId).toBe('thread-new')

    const start = captured.calls.find((call) => call.method === 'thread/start')
    // A Brainstorming conversation reads and does not write. Widening this needs an approval
    // surface, and there is none.
    expect(start?.params).toEqual({
      cwd: '/tmp/work',
      sandbox: 'read-only',
      approvalPolicy: 'untrusted'
    })
  })

  it('resumes the recorded thread instead of starting a second one', async () => {
    const captured: Captured = { calls: [], command: null }
    const sink = collect()
    const driver = createCodexConversationDriver({
      runSession: fakeSession(completingScript, captured)
    })

    const result = await driver.runTurn({
      resumeSessionId: 'thread-old',
      cwd: '/tmp/work',
      text: 'again',
      developerInstructions: null,
      turnId: 'turn-1',
      onEvent: sink.onEvent
    })

    expect(captured.calls.map((call) => call.method)).toEqual(['thread/resume', 'turn/start'])
    expect(result.providerSessionId).toBe('thread-resumed')
  })

  it('starts a new thread when the provider no longer has the old one, and says so', async () => {
    const captured: Captured = { calls: [], command: null }
    const sink = collect()
    const driver = createCodexConversationDriver({
      runSession: fakeSession(async (method, params, notify) => {
        if (method === 'thread/resume') {
          throw new Error('thread not found')
        }
        return completingScript(method, params, notify)
      }, captured)
    })

    const result = await driver.runTurn({
      resumeSessionId: 'thread-gone',
      cwd: '/tmp/work',
      text: 'still here?',
      developerInstructions: null,
      turnId: 'turn-1',
      onEvent: sink.onEvent
    })

    expect(captured.calls.map((call) => call.method)).toEqual([
      'thread/resume',
      'thread/start',
      'turn/start'
    ])
    // A lost provider thread is not a lost conversation, and the surface is told rather than left
    // to imply the model still remembers the earlier turns.
    expect(sink.events).toContainEqual({
      kind: 'provider-status',
      status: 'thread-resume-failed',
      detail: 'thread not found'
    })
    expect(result.providerSessionId).toBe('thread-new')
  })

  it('falls back when the resume is accepted but names no thread', async () => {
    const captured: Captured = { calls: [], command: null }
    const sink = collect()
    const driver = createCodexConversationDriver({
      runSession: fakeSession(async (method, params, notify) => {
        if (method === 'thread/resume') {
          return {}
        }
        return completingScript(method, params, notify)
      }, captured)
    })

    await driver.runTurn({
      resumeSessionId: 'thread-empty',
      cwd: '/tmp/work',
      text: 'hi',
      developerInstructions: null,
      turnId: 'turn-1',
      onEvent: sink.onEvent
    })

    expect(captured.calls.map((call) => call.method)).toContain('thread/start')
    expect(
      sink.events.some(
        (event) => event.kind === 'provider-status' && event.status === 'thread-resume-empty'
      )
    ).toBe(true)
  })
})

describe('codex conversation driver — the turn advances by notification', () => {
  it('normalizes the stream into the neutral vocabulary', async () => {
    const captured: Captured = { calls: [], command: null }
    const sink = collect()
    const driver = createCodexConversationDriver({
      runSession: fakeSession(completingScript, captured)
    })

    await driver.runTurn({
      resumeSessionId: null,
      cwd: '/tmp/work',
      text: 'hello',
      developerInstructions: null,
      turnId: 'turn-1',
      onEvent: sink.onEvent
    })

    expect(sink.events.map((event) => event.kind)).toEqual([
      'turn-started',
      'assistant-delta',
      'assistant-delta',
      'message-completed',
      'turn-completed'
    ])
  })

  it('does not return until the provider settles the turn', async () => {
    const captured: Captured = { calls: [], command: null }
    const sink = collect()
    let completeTurn: () => void = () => {}

    const driver = createCodexConversationDriver({
      runSession: fakeSession(async (method, _params, notify) => {
        if (method === 'thread/start') {
          return { thread: { id: 'thread-new' } }
        }
        if (method === 'turn/start') {
          // Acknowledged immediately; the answer arrives later, which is the real shape.
          completeTurn = () => notify('turn/completed', { turn: { id: 'turn-1' } })
          return {}
        }
        return {}
      }, captured)
    })

    let returned = false
    const running = driver
      .runTurn({
        resumeSessionId: null,
        cwd: '/tmp/work',
        text: 'slow',
        developerInstructions: null,
        turnId: 'turn-1',
        onEvent: sink.onEvent
      })
      .then((result) => {
        returned = true
        return result
      })

    await new Promise((resolve) => setTimeout(resolve, 30))
    // Returning here would end the session and kill the child mid-answer.
    expect(returned).toBe(false)

    completeTurn()
    const result = await running
    expect(returned).toBe(true)
    expect(result.providerSessionId).toBe('thread-new')
  })
})

describe('codex conversation driver — an agent’s instructions', () => {
  const ROLE = 'You are the Orca agent named "Ada".'

  it('layers the agent onto a new thread as developer instructions', async () => {
    const captured: Captured = { calls: [], command: null }
    const driver = createCodexConversationDriver({
      runSession: fakeSession(completingScript, captured)
    })

    await driver.runTurn({
      resumeSessionId: null,
      cwd: '/tmp/work',
      text: 'hello',
      developerInstructions: ROLE,
      turnId: 'turn-1',
      onEvent: collect().onEvent
    })

    const start = captured.calls.find((call) => call.method === 'thread/start')
    expect(start?.params).toEqual({
      cwd: '/tmp/work',
      sandbox: 'read-only',
      approvalPolicy: 'untrusted',
      developerInstructions: ROLE
    })
  })

  // Without this the role would apply to the first turn only: every later turn resumes.
  it('sends the agent again when resuming the thread', async () => {
    const captured: Captured = { calls: [], command: null }
    const driver = createCodexConversationDriver({
      runSession: fakeSession(completingScript, captured)
    })

    await driver.runTurn({
      resumeSessionId: 'thread-old',
      cwd: '/tmp/work',
      text: 'again',
      developerInstructions: ROLE,
      turnId: 'turn-1',
      onEvent: collect().onEvent
    })

    const resume = captured.calls.find((call) => call.method === 'thread/resume')
    expect(resume?.params).toEqual({ threadId: 'thread-old', developerInstructions: ROLE })
  })

  // baseInstructions REPLACES the provider's own. A user-written role must never reach it.
  it('never uses the slot that replaces the provider’s base instructions', async () => {
    const captured: Captured = { calls: [], command: null }
    const driver = createCodexConversationDriver({
      runSession: fakeSession(completingScript, captured)
    })

    await driver.runTurn({
      resumeSessionId: null,
      cwd: '/tmp/work',
      text: 'hello',
      developerInstructions: ROLE,
      turnId: 'turn-1',
      onEvent: collect().onEvent
    })

    // Positive control first: the role DID travel, so its absence below is not a blind read.
    // Compared on the field, not a JSON dump — stringify escapes the quotes inside ROLE.
    expect(
      captured.calls.some(
        (call) => (call.params as Record<string, unknown>).developerInstructions === ROLE
      )
    ).toBe(true)
    for (const call of captured.calls) {
      expect(call.params as Record<string, unknown>).not.toHaveProperty('baseInstructions')
    }
  })
})
