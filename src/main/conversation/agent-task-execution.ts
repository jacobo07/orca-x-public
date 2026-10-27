// Runs a delegated orchestration task as a turn of the assigned agent, through the same runner a
// person's message uses. One path: no second chat stack, no second location rule, no second auth.
import type { Agent } from '../../shared/agent-types'
import type { ProviderType } from '../../shared/agent-status-types'
import type { ConversationRecord } from '../../shared/conversation-types'
import type {
  AgentTaskOutcome,
  AgentTaskRequest
} from '../runtime/orchestration/agent-task-contract'
import type { ConversationTurnOutcome } from '../../shared/conversation-turn'
import {
  runConversationTurn,
  type ConversationTurnDeps,
  type ConversationTurnRequest
} from './conversation-turn-runner'

export type AgentTaskExecutionDeps = ConversationTurnDeps & {
  readAgents: () => readonly Agent[]
  /** The desktop hands in a ROUTED turn here, so a delegated task picks its provider the same way
   *  a person's message does, and reports which one ran it. Absent, the deps' own driver runs it. */
  runRoutedTurn?: (
    request: ConversationTurnRequest,
    requirement: { exclude?: readonly ProviderType[] }
  ) => Promise<{ turn: ConversationTurnOutcome; provider: ProviderType | null }>
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

/** A first turn opens the task's conversation; a follow-up continues it, and only as the agent it
 *  belongs to — a conversation id from a stored result is evidence, never authority. */
async function openTaskConversation(
  deps: AgentTaskExecutionDeps,
  request: AgentTaskRequest,
  agent: Agent
): Promise<{ conversationId: string } | { refused: AgentTaskOutcome }> {
  if (request.continueConversationId) {
    const loaded = await deps.service.read(request.continueConversationId)
    if (loaded.outcome !== 'loaded' || loaded.record.agentId !== agent.id) {
      return {
        refused: {
          outcome: 'refused',
          reason: 'task-conversation-unavailable',
          detail: `The conversation for task ${request.taskId} is not ${agent.name}'s, or cannot be read.`
        }
      }
    }
    return { conversationId: loaded.record.id }
  }
  const created = await deps.service.createForAgent({ agentId: agent.id, title: `Task ${request.taskId}` })
  if (created.outcome !== 'created') {
    return {
      refused: { outcome: 'refused', reason: created.outcome, detail: 'The agent could not be verified.' }
    }
  }
  return { conversationId: created.record.id }
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

  const exclude = (request.excludeProviders ?? []) as readonly ProviderType[]
  if (!deps.runRoutedTurn && exclude.includes(deps.driver.provider)) {
    // Why: an unrouted host has one driver; running an excluded provider would void the exclusion.
    return {
      outcome: 'refused',
      reason: 'no-provider',
      detail: `${deps.driver.provider} is excluded for this task and no other provider is available.`
    }
  }

  const conversation = await openTaskConversation(deps, request, agent)
  if ('refused' in conversation) {
    return conversation.refused
  }
  const { conversationId } = conversation

  const turnRequest = {
    conversationId,
    text: composeDelegatedTaskText(request),
    cwd: null,
    ...(request.tools ? { tools: request.tools } : {})
  }
  let turn: ConversationTurnOutcome
  let provider: ProviderType | null
  if (deps.runRoutedTurn) {
    ;({ turn, provider } = await deps.runRoutedTurn(turnRequest, { exclude }))
  } else {
    turn = await runConversationTurn(deps, turnRequest)
    provider = deps.driver.provider
  }
  switch (turn.outcome) {
    case 'completed': {
      // The runner awaits its durable writes before answering `completed`, so the reply is on disk.
      const loaded = await deps.service.read(conversationId)
      if (loaded.outcome !== 'loaded') {
        return { outcome: 'failed', reason: 'reply-unreadable', conversationId, turnId: turn.turnId, provider }
      }
      return {
        outcome: 'completed',
        conversationId,
        turnId: turn.turnId,
        text: replyText(loaded.record, turn.turnId),
        provider
      }
    }
    case 'failed':
      return { outcome: 'failed', reason: turn.reason, conversationId, turnId: turn.turnId, provider }
    case 'not-durable':
      return { outcome: 'failed', reason: `not-durable: ${turn.reason}`, conversationId, turnId: null, provider }
    case 'auth-required':
      return { outcome: 'refused', reason: 'auth-required', detail: turn.detail }
    case 'no-provider':
      return { outcome: 'refused', reason: 'no-provider', detail: turn.detail }
    case 'provider-unavailable':
      return { outcome: 'refused', reason: `provider-${turn.reason}`, detail: turn.detail }
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
