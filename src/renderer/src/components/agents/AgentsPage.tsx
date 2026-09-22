import { useCallback, useEffect, useState } from 'react'

import { translate } from '@/i18n/i18n'
import type { Agent } from '../../../../shared/agent-types'

/**
 * The persistent Agents directory: the durable actors in `PersistedState.agents[]`, which outlive
 * the pane, the provider session and the process.
 *
 * What a row may say is decided by what the record OWNS, and the record owns four things: an id, a
 * name, a role and a project relation. So the row shows a name and a role and nothing else. No
 * provider, no host, no online dot, no "last message", no run count — every one of those has zero
 * producer today, and a plausible value with no producer is a lie that happens to be well-formed.
 *
 * Rows are not clickable, deliberately. The interaction a row of this shape promises is "talk to
 * this agent", and Direct Agent Chat does not exist: an Agent owns a `role` and nothing compiles it
 * into a turn, so opening one would be a Brainstorming chat wearing a label. A row that looks like
 * a conversation and opens nothing is worse than a row that never offered. They become buttons in
 * the wave that gives them somewhere to go.
 *
 * Grouping by project arrives in W-C3F; this wave establishes the surface, the read and the honest
 * empty state.
 */

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; agents: readonly Agent[] }
  | { status: 'failed'; reason: string }

export default function AgentsPage(): React.JSX.Element {
  const [state, setState] = useState<LoadState>({ status: 'loading' })

  const refresh = useCallback(async () => {
    try {
      setState({ status: 'ready', agents: await window.api.agents.list() })
    } catch (error) {
      // "We could not read the roster" and "you have no agents" are different things to tell
      // someone, and rendering the first as the second invites them to create a duplicate of an
      // agent that is already there.
      setState({
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error)
      })
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <div className="flex h-full min-h-0 w-full flex-col" data-testid="agents-page">
      <header className="border-b border-border px-6 py-4">
        <h1 className="text-lg font-medium" tabIndex={-1} data-testid="agents-page-heading">
          {translate('agents.pageTitle', 'Agents')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {translate(
            'agents.pageSubtitle',
            'People you keep. An agent stays between sessions; a chat does not.'
          )}
        </p>
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
        {state.status === 'loading' ? (
          <p className="text-sm text-muted-foreground" role="status" data-testid="agents-loading">
            {translate('agents.loading', 'Loading agents…')}
          </p>
        ) : null}

        {state.status === 'failed' ? (
          <p className="text-sm text-destructive" role="alert" data-testid="agents-read-error">
            {translate('agents.readFailed', 'Could not read your agents.')} {state.reason}
          </p>
        ) : null}

        {state.status === 'ready' && state.agents.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="agents-empty">
            {translate('agents.empty', 'You have no agents yet.')}
          </p>
        ) : null}

        {state.status === 'ready' && state.agents.length > 0 ? (
          <ul className="flex flex-col gap-1" data-testid="agents-list">
            {state.agents.map((agent) => (
              <li
                key={agent.id}
                data-testid="agents-list-row"
                data-agent-id={agent.id}
                className="rounded-md px-3 py-2"
              >
                <span className="text-sm">{agent.name}</span>
                {agent.role ? (
                  <span className="ml-2 text-sm text-muted-foreground">{agent.role}</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  )
}
