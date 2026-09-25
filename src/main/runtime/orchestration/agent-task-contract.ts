// The contract between orchestration (which owns the task) and the conversation layer (which owns
// an agent's turn). Orchestration never imports the conversation service; a host that can run agent
// turns registers a runner, and a host that cannot (headless `orca serve`) leaves tasks waiting.
import type { DelegationSubject } from './types'
import type { ProviderTurnTool } from '../../conversation/provider-turn-tool'

export type AgentTaskRequest = {
  taskId: string
  agentId: string
  spec: string
  subject: DelegationSubject | null
  /** Built by orchestration with this task's authority bound in; the turn only offers them. */
  tools?: readonly ProviderTurnTool[]
  /** A follow-up turn continues the task's own conversation instead of opening a new one. */
  continueConversationId?: string
  /** Providers this turn must not run on, e.g. the one that produced what is being reviewed. */
  excludeProviders?: readonly string[]
}

/** `provider` is the one whose driver actually ran the turn — evidence for review independence.
 *  Absent or null means it is not known, never that no provider was involved. */
export type AgentTaskOutcome =
  | { outcome: 'completed'; conversationId: string; turnId: string; text: string; provider?: string | null }
  /** Nothing ran: the agent, its project or its provider could not take the work. */
  | { outcome: 'refused'; reason: string; detail: string }
  /** A turn started and did not complete; the conversation keeps what was said. */
  | {
      outcome: 'failed'
      reason: string
      conversationId: string | null
      turnId: string | null
      provider?: string | null
    }

export type AgentTaskRunner = (request: AgentTaskRequest) => Promise<AgentTaskOutcome>

/** Stored in `tasks.result` so a parent reads a structure, not prose. `round` counts the holding
 *  agent's turns on this task; `awaitingChildren` marks a turn that delegated and now waits. */
export type AgentTaskResult = {
  schema: 'orca.agent-task-result/1'
  round?: number
  awaitingChildren?: boolean
} & AgentTaskOutcome

export function serializeAgentTaskResult(
  outcome: AgentTaskOutcome,
  progress: { round?: number; awaitingChildren?: boolean } = {}
): string {
  const result: AgentTaskResult = { schema: 'orca.agent-task-result/1', ...progress, ...outcome }
  return JSON.stringify(result)
}

export function parseAgentTaskResult(raw: string | null): AgentTaskResult | null {
  if (!raw) {
    return null
  }
  try {
    const value = JSON.parse(raw) as Partial<AgentTaskResult>
    return value?.schema === 'orca.agent-task-result/1' ? (value as AgentTaskResult) : null
  } catch {
    return null
  }
}

/** `unreadable` is never folded into `none`: a task whose subject was damaged must not run as if it
 *  had no subject, which would let the work land on whatever the agent's project resolves to. */
export type ParsedDelegationSubject =
  | { kind: 'none' }
  | { kind: 'subject'; subject: DelegationSubject }
  | { kind: 'unreadable' }

export function parseDelegationSubject(raw: string | null): ParsedDelegationSubject {
  if (!raw) {
    return { kind: 'none' }
  }
  let value: Partial<DelegationSubject>
  try {
    value = JSON.parse(raw) as Partial<DelegationSubject>
  } catch {
    return { kind: 'unreadable' }
  }
  if (typeof value.projectId !== 'string' || !value.projectId) {
    return { kind: 'unreadable' }
  }
  return {
    kind: 'subject',
    subject: {
      projectId: value.projectId,
      worktreePath: typeof value.worktreePath === 'string' ? value.worktreePath : null,
      revision: typeof value.revision === 'string' ? value.revision : null
    }
  }
}
