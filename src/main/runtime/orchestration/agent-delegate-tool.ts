// The one tool an agent's turn gets for asking another agent to do work. Everything that grants
// authority is bound here, from the task being worked; the provider's arguments name only WHO and
// WHAT. A claimed requester, parent or subject in the arguments has nowhere to go.
import type { ProviderTurnTool } from '../../conversation/provider-turn-tool'
import type { OrchestrationDb } from './db'
import type { TaskRow } from './types'
import { DelegationRefusedError } from './delegation-bounds'
import { parseDelegationSubject } from './agent-task-contract'

export const DELEGATE_TOOL_NAME = 'orca_delegate'

function readArguments(args: unknown): { agent: string; task: string } | null {
  const value = args as { agent?: unknown; task?: unknown } | null
  const agent = typeof value?.agent === 'string' ? value.agent.trim() : ''
  const task = typeof value?.task === 'string' ? value.task.trim() : ''
  return agent && task ? { agent, task } : null
}

export function createDelegateTool(db: OrchestrationDb, holding: TaskRow): ProviderTurnTool {
  const requesterAgentId = holding.assignee_agent_id
  return {
    name: DELEGATE_TOOL_NAME,
    description:
      'Ask another Orca agent to do part of this task. It runs as that agent, in its own project, ' +
      'and its result is recorded on the new task. Returns the new task id.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'The id of the agent to delegate to.' },
        task: { type: 'string', description: 'What that agent should do.' }
      },
      required: ['agent', 'task'],
      additionalProperties: false
    },
    invoke: async (args) => {
      if (!requesterAgentId) {
        return { success: false, text: 'This task is not held by an agent, so it cannot delegate.' }
      }
      const request = readArguments(args)
      if (!request) {
        return { success: false, text: 'Both "agent" and "task" are required.' }
      }
      const subject = parseDelegationSubject(holding.subject)
      try {
        const child = db.createTask({
          spec: request.task,
          parentId: holding.id,
          runId: holding.run_id,
          assigneeAgentId: request.agent,
          requesterAgentId,
          ...(subject.kind === 'subject' ? { subject: subject.subject } : {})
        })
        return {
          success: true,
          text: `Delegated as task ${child.id} to ${request.agent}; its result will be recorded on that task.`
        }
      } catch (error) {
        if (error instanceof DelegationRefusedError) {
          return { success: false, text: `Delegation refused: ${error.refusal.code}.` }
        }
        throw error
      }
    }
  }
}
