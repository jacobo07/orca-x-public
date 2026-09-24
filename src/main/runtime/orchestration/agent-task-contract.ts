// The contract between orchestration (which owns the task) and the conversation layer (which owns
// an agent's turn). Orchestration never imports the conversation service; a host that can run agent
// turns registers a runner, and a host that cannot (headless `orca serve`) leaves tasks waiting.
import type { DelegationSubject } from './types'

export type AgentTaskRequest = {
  taskId: string
  agentId: string
  spec: string
  subject: DelegationSubject | null
}

export type AgentTaskOutcome =
  | { outcome: 'completed'; conversationId: string; turnId: string; text: string }
  /** Nothing ran: the agent, its project or its provider could not take the work. */
  | { outcome: 'refused'; reason: string; detail: string }
  /** A turn started and did not complete; the conversation keeps what was said. */
  | { outcome: 'failed'; reason: string; conversationId: string | null; turnId: string | null }

export type AgentTaskRunner = (request: AgentTaskRequest) => Promise<AgentTaskOutcome>

/** Stored in `tasks.result` so a parent reads a structure, not prose. */
export type AgentTaskResult = { schema: 'orca.agent-task-result/1' } & AgentTaskOutcome

export function serializeAgentTaskResult(outcome: AgentTaskOutcome): string {
  const result: AgentTaskResult = { schema: 'orca.agent-task-result/1', ...outcome }
  return JSON.stringify(result)
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
