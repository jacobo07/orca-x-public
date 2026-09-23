import { useCallback, useEffect, useMemo, useState } from 'react'

import type { Agent } from '../../../../shared/agent-types'

import type { WorkspaceAgentsLoad } from './CognitiveWorkspaceRoster'

/** "Not found" and "could not read the roster" stay apart: the second is no evidence the agent is
 *  gone, and saying it is would send someone to recreate an agent that still exists. */
export type ScopedAgentLookup =
  | { status: 'loading' }
  | { status: 'found'; agent: Agent }
  | { status: 'missing'; agentId: string }
  | { status: 'failed'; reason: string }

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
    | { status: 'failed'; reason: string }
  >({ status: 'loading' })

  const refresh = useCallback(async () => {
    try {
      setState({ status: 'ready', agents: await window.api.agents.list() })
    } catch (error) {
      setState({ status: 'failed', reason: error instanceof Error ? error.message : String(error) })
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
    if (state.status === 'failed') {
      return { status: 'failed', reason: state.reason }
    }
    const agent = state.agents.find((entry) => entry.id === agentScope)
    return agent ? { status: 'found', agent } : { status: 'missing', agentId: agentScope }
  }, [agentScope, state])

  const load: WorkspaceAgentsLoad =
    state.status === 'failed'
      ? { status: 'failed', reason: state.reason }
      : { status: state.status }
  return { load, agents, scoped, refresh }
}

const EMPTY: readonly Agent[] = []
