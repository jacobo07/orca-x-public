// The Cognitive Workspace roster as every client renders it: agents, threads and the project each
// belongs to, DERIVED from the canonical roster, conversation summaries and project list.
//
// One module on purpose. Desktop and mobile are two projections of the same workstation, and a
// second derivation would eventually disagree about whose project a thread is in. Nothing here is
// stored or cached — a Project id is promoted in place (repo: -> git: -> github:), and a memoised
// answer would keep naming the pre-promotion project.
//
// A thread's project is its AGENT's project, the relation the turn runner resolves per turn.
// `ConversationRecord.projectId` is a Brainstorming-only field with no producer, so it is never
// consulted here.

import type { Agent } from './agent-types'
import type { ConversationSummary } from './conversation-summary'
import type { ConversationTurnState } from './conversation-types'
import type { Project } from './project-types'

/** `unresolved` is an agent naming a project that cannot be found right now — never folded into
 *  `none`, which is a person's deliberate choice of no project. */
export type WorkspaceProjectRef =
  | { kind: 'project'; projectId: string; displayName: string }
  | { kind: 'none' }
  | { kind: 'unresolved'; projectId: string }
  /** No agent record to ask: the thread's agent is missing from the roster. */
  | { kind: 'unknown' }

export type WorkspaceAgentRow = {
  agent: Agent
  project: WorkspaceProjectRef
  /** Most recent activity in any of this agent's readable threads; null when none exist. */
  lastActivityAt: number | null
  lastTurnState: ConversationTurnState | null
  threadCount: number
}

export type WorkspaceThreadRow =
  | {
      outcome: 'ok'
      id: string
      title: string | null
      updatedAt: number
      /** null is Brainstorming. `missing` is a thread whose agent is no longer in the roster. */
      agent: { kind: 'agent'; agentId: string; name: string } | { kind: 'missing'; agentId: string } | null
      project: WorkspaceProjectRef
      lastTurnState: ConversationTurnState | null
    }
  | { outcome: 'unreadable'; id: string; reason: string }
  | { outcome: 'schema-too-new'; id: string; storedVersion: number }

export function projectRefFor(
  projectId: string | null,
  projectsById: ReadonlyMap<string, Project>
): WorkspaceProjectRef {
  if (projectId === null) {
    return { kind: 'none' }
  }
  const project = projectsById.get(projectId)
  return project
    ? { kind: 'project', projectId, displayName: project.displayName }
    : { kind: 'unresolved', projectId }
}

function indexProjects(projects: readonly Project[]): Map<string, Project> {
  return new Map(projects.map((project) => [project.id, project]))
}

/** Agents in roster order, each with the activity its threads carry. */
export function projectWorkspaceAgents(
  agents: readonly Agent[],
  projects: readonly Project[],
  summaries: readonly ConversationSummary[]
): WorkspaceAgentRow[] {
  const projectsById = indexProjects(projects)
  const activity = new Map<
    string,
    { at: number; state: ConversationTurnState | null; count: number }
  >()
  for (const summary of summaries) {
    if (summary.outcome !== 'ok' || summary.agentId === null) {
      continue
    }
    const current = activity.get(summary.agentId)
    if (!current) {
      activity.set(summary.agentId, {
        at: summary.updatedAt,
        state: summary.lastTurnState,
        count: 1
      })
      continue
    }
    current.count += 1
    if (summary.updatedAt > current.at) {
      current.at = summary.updatedAt
      current.state = summary.lastTurnState
    }
  }
  return agents.map((agent) => {
    const seen = activity.get(agent.id)
    return {
      agent,
      project: projectRefFor(agent.projectId, projectsById),
      lastActivityAt: seen?.at ?? null,
      lastTurnState: seen?.state ?? null,
      threadCount: seen?.count ?? 0
    }
  })
}

/** Threads in the order given (callers pass summaries newest-first). Unreadable rows are kept. */
export function projectWorkspaceThreads(
  summaries: readonly ConversationSummary[],
  agents: readonly Agent[],
  projects: readonly Project[]
): WorkspaceThreadRow[] {
  const projectsById = indexProjects(projects)
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]))
  return summaries.map((summary): WorkspaceThreadRow => {
    if (summary.outcome !== 'ok') {
      return summary
    }
    const agent = summary.agentId === null ? undefined : agentsById.get(summary.agentId)
    return {
      outcome: 'ok',
      id: summary.id,
      title: summary.title,
      updatedAt: summary.updatedAt,
      agent:
        summary.agentId === null
          ? null
          : agent
            ? { kind: 'agent', agentId: agent.id, name: agent.name }
            : { kind: 'missing', agentId: summary.agentId },
      // A thread whose agent is gone has an unknowable project — not "none", which is a choice.
      project: agent
        ? projectRefFor(agent.projectId, projectsById)
        : summary.agentId === null
          ? { kind: 'none' }
          : { kind: 'unknown' },
      lastTurnState: summary.lastTurnState
    }
  })
}
