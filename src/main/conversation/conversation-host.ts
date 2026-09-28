import type { AgentGrounding } from '../../shared/agent-grounding'
import type { AgentTurnEvent } from '../../shared/agent-turn-event'
import type { Agent } from '../../shared/agent-types'
import {
  projectWorkspaceAgents,
  projectWorkspaceThreads,
  type WorkspaceAgentRow,
  type WorkspaceThreadRow
} from '../../shared/cognitive-workspace-projection'
import type { ConversationSummary } from '../../shared/conversation-summary'
import type {
  ConversationForAgentResult,
  ConversationLoadResult
} from '../../shared/conversation-types'
import type { Project } from '../../shared/project-types'
import type { ConversationTurnOutcome } from './conversation-turn-runner'

/**
 * What a paired client may ask of this host's conversations: the operations the desktop renderer
 * uses, served by the SAME handlers (one ConversationService, one turn admission), minus what a
 * remote caller must not steer.
 *
 * - No `cwd`: where a turn runs is decided by the agent's project and the turn runner, never by a
 *   remote request. Accepting it would make a phone an arbitrary-path executor on this machine.
 * - No Brainstorming create: remote chat is with a durable agent, whose project grounds the turn.
 * - The roster is projected HERE with the shared projection, so desktop and phone cannot disagree
 *   about whose project a thread is in.
 */
export type ConversationHost = {
  readWorkspace: () => Promise<{ agents: WorkspaceAgentRow[]; threads: WorkspaceThreadRow[] }>
  read: (id: string) => Promise<ConversationLoadResult>
  agentGrounding: (agentId: string) => Promise<AgentGrounding>
  createForAgent: (args: {
    agentId: string
    title: string | null
  }) => Promise<ConversationForAgentResult>
  sendTurn: (args: { id: string; text: string }) => Promise<ConversationTurnOutcome>
  /** Events for ONE conversation; returns the unsubscribe. */
  subscribeTurnEvents: (
    conversationId: string,
    listener: (event: AgentTurnEvent) => void
  ) => () => void
}

export type ConversationTurnEventListener = (payload: {
  conversationId: string
  event: AgentTurnEvent
}) => void

export type ConversationHostDeps = {
  list: () => Promise<ConversationSummary[]>
  read: (args: { id: string }) => Promise<ConversationLoadResult>
  agentGrounding: (args: { agentId: string }) => Promise<AgentGrounding>
  createForAgent: (args: {
    agentId: string
    title?: string | null
  }) => Promise<ConversationForAgentResult>
  sendTurn: (args: {
    id: string
    text: string
    cwd?: string | null
  }) => Promise<ConversationTurnOutcome>
  readAgents: () => readonly Agent[]
  readProjects: () => readonly Project[]
  subscribe: (listener: ConversationTurnEventListener) => () => void
}

export function createConversationHost(deps: ConversationHostDeps): ConversationHost {
  return {
    readWorkspace: async () => {
      const summaries = await deps.list()
      const agents = deps.readAgents()
      const projects = deps.readProjects()
      return {
        agents: projectWorkspaceAgents(agents, projects, summaries),
        threads: projectWorkspaceThreads(summaries, agents, projects)
      }
    },
    read: (id) => deps.read({ id }),
    agentGrounding: (agentId) => deps.agentGrounding({ agentId }),
    createForAgent: ({ agentId, title }) => deps.createForAgent({ agentId, title }),
    // The one place a remote turn enters: cwd is fixed to "not given", whatever the caller sent.
    sendTurn: ({ id, text }) => deps.sendTurn({ id, text, cwd: null }),
    subscribeTurnEvents: (conversationId, listener) =>
      deps.subscribe((payload) => {
        if (payload.conversationId === conversationId) {
          listener(payload.event)
        }
      })
  }
}
