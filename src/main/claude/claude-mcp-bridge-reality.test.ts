// Opt-in product reality (ORCA_CLAUDE_REALITY=1; one real Claude turn): the Claude driver serves an
// Orca tool over its per-turn MCP server, and the real `claude` process, in plan mode with only that
// tool pre-allowed, calls it with arguments it chose.
import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import type { AgentTurnEvent } from '../../shared/agent-turn-event'
import { createClaudeConversationDriver } from './claude-conversation-driver'

const ENABLED = process.env.ORCA_CLAUDE_REALITY === '1'

describe.skipIf(!ENABLED)('Claude calling an Orca tool over the per-turn MCP bridge', () => {
  it('calls the served tool with its own arguments and completes the turn', async () => {
    const calls: unknown[] = []
    const events: AgentTurnEvent[] = []
    const requests: unknown[] = []

    await createClaudeConversationDriver({ observeToolServerRequest: (r) => requests.push(r) }).runTurn({
      resumeSessionId: null,
      cwd: tmpdir(),
      text: 'Call the orca_delegate tool once, with agent "agent_probe" and task "say hello". Then reply with exactly: done',
      developerInstructions: null,
      turnId: 'turn-bridge',
      onEvent: (event) => events.push(event),
      tools: [
        {
          name: 'orca_delegate',
          description: 'Ask another Orca agent to do part of this task. Returns the new task id.',
          inputSchema: {
            type: 'object',
            properties: { agent: { type: 'string' }, task: { type: 'string' } },
            required: ['agent', 'task'],
            additionalProperties: false
          },
          invoke: async (args) => {
            calls.push(args)
            return { success: true, text: 'Delegated as task task_probe.' }
          }
        }
      ]
    })

    console.info(`BRIDGE_REALITY ${JSON.stringify({ calls, requests, events })}`)
    expect(calls).toEqual([{ agent: 'agent_probe', task: 'say hello' }])
    expect(events.at(-1)).toMatchObject({ kind: 'turn-completed' })
  }, 300_000)
})
