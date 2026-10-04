import { useCallback, useEffect, useMemo, useState } from 'react'

import type { Agent, AgentRosterRead } from '../../../../shared/agent-types'

import type { WorkspaceAgentsLoad } from './CognitiveWorkspaceRoster'

/** "Not found" and "could not read the roster" stay apart: the second is no evidence the agent is
 *  gone, and saying it is would send someone to recreate an agent that still exists. */
export type ScopedAgentLookup =
  | { status: 'loading' }
  | { status: 'found'; agent: Agent }
  | { status: 'missing'; agentId: string }
  // The catalog exists but cannot be read: not "missing", and not a failure a retry could clear.
  | { status: 'unreadable' }
  // This client has no agent directory: not "missing" either.
  | { status: 'unavailable' }
  // No message field on purpose: an exception string is not product copy.
  | { status: 'failed' }

/**
 * The roster, read once through main's authority and re-read on demand (after a create), never
 * spliced locally. The scoped lookup is derived from the same read, so the header and the roster
 * can never disagree about whether the open agent exists.
 */
export function useWorkspaceAgents(agentScope: string | null): {
  load: WorkspaceAgentsLoad
  agents: readonly Agent[]
  scoped: ScopedAgentLookup | null
  refresh: () => Promise<void>
} {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; agents: readonly Agent[] }
    | { status: 'unreadable' }
    | { status: 'unavailable' }
    | { status: 'failed' }
  >({ status: 'loading' })

  const refresh = useCallback(async () => {
    try {
      setState(classifyRosterRead(await window.api.agents.roster()))
    } catch {
      setState({ status: 'failed' })
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const agents = state.status === 'ready' ? state.agents : EMPTY
  const scoped = useMemo((): ScopedAgentLookup | null => {
    if (agentScope === null) {
      return null
    }
    if (state.status === 'loading') {
      return { status: 'loading' }
    }
    if (state.status !== 'ready') {
      return { status: state.status }
    }
    const agent = state.agents.find((entry) => entry.id === agentScope)
    return agent ? { status: 'found', agent } : { status: 'missing', agentId: agentScope }
  }, [agentScope, state])

  const load: WorkspaceAgentsLoad = { status: state.status }
  return { load, agents, scoped, refresh }
}

/** The answer is data from another layer: anything that is not a known shape is a failed read, never an empty roster. */
function classifyRosterRead(
  read: unknown
):
  | { status: 'ready'; agents: readonly Agent[] }
  | { status: 'unreadable' }
  | { status: 'unavailable' }
  | { status: 'failed' } {
  const answer = read as Partial<AgentRosterRead> | null | undefined
  if (answer?.status === 'readable' && Array.isArray(answer.agents)) {
    return { status: 'ready', agents: answer.agents }
  }
  if (answer?.status === 'unreadable' || answer?.status === 'unavailable') {
    return { status: answer.status }
  }
  return { status: 'failed' }
}

const EMPTY: readonly Agent[] = []
