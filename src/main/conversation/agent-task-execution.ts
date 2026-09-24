// Runs a delegated orchestration task as a turn of the assigned agent, through the same runner a
// person's message uses. One path: no second chat stack, no second location rule, no second auth.
import type { Agent } from '../../shared/agent-types'
import type { ConversationRecord } from '../../shared/conversation-types'
import type {
  AgentTaskOutcome,
  AgentTaskRequest
} from '../runtime/orchestration/agent-task-contract'
import { runConversationTurn, type ConversationTurnDeps } from './conversation-turn-runner'

export type AgentTaskExecutionDeps = ConversationTurnDeps & {
  readAgents: () => readonly Agent[]
}

/** The task text the agent receives. The subject is stated, never inferred by the agent. */
export function composeDelegatedTaskText(request: AgentTaskRequest): string {
  const lines = [`Delegated task ${request.taskId}.`]
  if (request.subject) {
    lines.push(
      `Subject: project ${request.subject.projectId}` +
        (request.subject.revision ? ` at revision ${request.subject.revision}` : '') +
        '.'
    )
  }
  lines.push('', request.spec)
  return lines.join('\n')
}

function replyText(record: ConversationRecord, turnId: string): string {
  return record.messages
    .filter((message) => message.turnId === turnId && message.role === 'assistant')
    .flatMap((message) => message.blocks)
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter((text) => text.length > 0)
    .join('\n')
}

export async function runAgentTask(
  deps: AgentTaskExecutionDeps,
  request: AgentTaskRequest
): Promise<AgentTaskOutcome> {
  const agent = deps.readAgents().find((entry) => entry.id === request.agentId)
  if (!agent) {
    return { outcome: 'refused', reason: 'agent-not-found', detail: `No agent ${request.agentId}.` }
  }
  // Why: a delegation names its subject; an agent bound to another project must not be handed it.
  if (request.subject && request.subject.projectId !== agent.projectId) {
    return {
      outcome: 'refused',
      reason: 'subject-project-mismatch',
      detail: `The task is about ${request.subject.projectId}; ${agent.name} works on ${agent.projectId ?? 'no project'}.`
    }
  }

  const created = await deps.service.createForAgent({
    agentId: agent.id,
    title: `Task ${request.taskId}`
  })
  if (created.outcome !== 'created') {
    return { outcome: 'refused', reason: created.outcome, detail: 'The agent could not be verified.' }
  }
  const conversationId = created.record.id

  const turn = await runConversationTurn(deps, {
    conversationId,
    text: composeDelegatedTaskText(request),
    cwd: null
  })
  switch (turn.outcome) {
    case 'completed': {
      // The runner awaits its durable writes before answering `completed`, so the reply is on disk.
      const loaded = await deps.service.read(conversationId)
      if (loaded.outcome !== 'loaded') {
        return { outcome: 'failed', reason: 'reply-unreadable', conversationId, turnId: turn.turnId }
      }
      return {
        outcome: 'completed',
        conversationId,
        turnId: turn.turnId,
        text: replyText(loaded.record, turn.turnId)
      }
    }
    case 'failed':
      return { outcome: 'failed', reason: turn.reason, conversationId, turnId: turn.turnId }
    case 'not-durable':
      return { outcome: 'failed', reason: `not-durable: ${turn.reason}`, conversationId, turnId: null }
    case 'auth-required':
      return { outcome: 'refused', reason: 'auth-required', detail: turn.detail }
    case 'project-unavailable':
      return { outcome: 'refused', reason: `project-${turn.reason}`, detail: turn.detail }
    case 'agent-unavailable':
      return { outcome: 'refused', reason: `agent-${turn.reason}`, detail: `Agent ${turn.agentId}.` }
    case 'busy':
      return { outcome: 'refused', reason: 'busy', detail: `Turn ${turn.activeTurnId} is running.` }
    case 'conversation-absent':
      return { outcome: 'failed', reason: 'conversation-absent', conversationId, turnId: null }
  }
}
