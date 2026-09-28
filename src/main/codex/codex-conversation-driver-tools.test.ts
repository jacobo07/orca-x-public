import { describe, expect, it } from 'vitest'

import type { ProviderTurnTool } from '../conversation/provider-turn-tool'
import type { CodexServerRequestOutcome } from './codex-app-server-inbound-router'
import { createCodexConversationDriver } from './codex-conversation-driver'
import type { runCodexAppServerSession } from './codex-app-server-session'

type Call = { method: string; params: unknown }
type ServerRequestHandler = (request: {
  id: number | string
  method: string
  params: unknown
}) => Promise<CodexServerRequestOutcome>

/** A peer that, mid-turn, asks the client to run a tool — the way Codex issues `item/tool/call`. */
function peerThatCallsTool(
  calls: Call[],
  answers: CodexServerRequestOutcome[],
  toolCall: { tool: string; arguments: unknown }
): typeof runCodexAppServerSession {
  return (async (
    _invocation: unknown,
    body: (rpc: { request: (method: string, params: unknown) => Promise<unknown> }) => Promise<unknown>,
    _spawn: unknown,
    handlers?: {
      onNotification?: (notification: { method: string; params: unknown }) => void
      onServerRequest?: ServerRequestHandler
    }
  ) => {
    const notify = (method: string, params: unknown): void =>
      handlers?.onNotification?.({ method, params })
    return body({
      request: async (method, params) => {
        calls.push({ method, params })
        if (method === 'thread/start') {
          return { thread: { id: 'thread-new' } }
        }
        if (method === 'turn/start') {
          notify('turn/started', { turn: { id: 'turn-1' } })
          const answer = await handlers!.onServerRequest!({
            id: 41,
            method: 'item/tool/call',
            params: { threadId: 'thread-new', turnId: 'turn-1', callId: 'call-1', ...toolCall }
          })
          answers.push(answer)
          notify('turn/completed', { turn: { id: 'turn-1' } })
        }
        return {}
      }
    })
  }) as unknown as typeof runCodexAppServerSession
}

describe('codex conversation driver — tools offered for a turn', () => {
  it('declares the tool on thread/start and routes the provider’s call to it', async () => {
    const calls: Call[] = []
    const answers: CodexServerRequestOutcome[] = []
    const invoked: unknown[] = []
    const delegate: ProviderTurnTool = {
      name: 'orca_delegate',
      description: 'Ask another agent.',
      inputSchema: { type: 'object', required: ['agent', 'task'] },
      invoke: async (args) => {
        invoked.push(args)
        return { success: true, text: 'Delegated as task task_7' }
      }
    }
    const driver = createCodexConversationDriver({
      command: 'codex-test',
      runSession: peerThatCallsTool(calls, answers, {
        tool: 'orca_delegate',
        arguments: { agent: 'agent_b', task: 'review' }
      })
    })

    await driver.runTurn({
      resumeSessionId: null,
      cwd: '/tmp/work',
      text: 'split this',
      developerInstructions: 'You coordinate.',
      turnId: 'turn-1',
      onEvent: () => {},
      tools: [delegate]
    })

    const start = calls.find((call) => call.method === 'thread/start')
    expect((start?.params as { dynamicTools?: unknown }).dynamicTools).toEqual([
      {
        type: 'function',
        name: 'orca_delegate',
        description: 'Ask another agent.',
        inputSchema: { type: 'object', required: ['agent', 'task'] }
      }
    ])
    expect(invoked).toEqual([{ agent: 'agent_b', task: 'review' }])
    expect(answers).toEqual([
      {
        outcome: 'result',
        result: { contentItems: [{ type: 'inputText', text: 'Delegated as task task_7' }], success: true }
      }
    ])
  })

  it('refuses the same call when the turn declared no tools', async () => {
    const calls: Call[] = []
    const answers: CodexServerRequestOutcome[] = []
    const driver = createCodexConversationDriver({
      command: 'codex-test',
      runSession: peerThatCallsTool(calls, answers, {
        tool: 'orca_delegate',
        arguments: { agent: 'agent_b', task: 'review' }
      })
    })

    await driver.runTurn({
      resumeSessionId: null,
      cwd: '/tmp/work',
      text: 'split this',
      developerInstructions: null,
      turnId: 'turn-1',
      onEvent: () => {}
    })

    const start = calls.find((call) => call.method === 'thread/start')
    expect(start?.params).not.toHaveProperty('dynamicTools')
    expect(answers[0]).toMatchObject({ outcome: 'error', code: -32601 })
  })
})
