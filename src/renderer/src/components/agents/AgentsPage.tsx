import { useCallback, useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { Agent } from '../../../../shared/agent-types'

import { groupAgentsByProject } from './agent-project-grouping'
import { resolveDefaultProjectId } from './default-agent-project'
import { NewAgentDialog } from './NewAgentDialog'

/**
 * The persistent Agents directory: the durable actors in `PersistedState.agents[]`, which outlive
 * the pane, the provider session and the process.
 *
 * What a row may say is decided by what the record OWNS, and the record owns four things: an id, a
 * name, a role and a project relation. So a row shows a name and a role and nothing else. No
 * provider, no host, no online dot, no "last message", no run count — every one of those has zero
 * producer today, and a plausible value with no producer is a lie that happens to be well-formed.
 *
 * Rows are not clickable, deliberately. The interaction a row of this shape promises is "talk to
 * this agent", and Direct Agent Chat does not exist: an Agent owns a `role` and nothing compiles it
 * into a turn, so opening one would be a Brainstorming chat wearing a label. A row that looks like
 * a conversation and opens nothing is worse than a row that never offered. They become buttons in
 * the wave that gives them somewhere to go.
 */

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; agents: readonly Agent[] }
  | { status: 'failed'; reason: string }

function AgentRow({ agent }: { agent: Agent }): React.JSX.Element {
  return (
    <li
      data-testid="agents-list-row"
      data-agent-id={agent.id}
      className="flex flex-col rounded-md px-3 py-2 hover:bg-muted/40"
    >
      <span className="text-sm">{agent.name}</span>
      {agent.role ? <span className="text-xs text-muted-foreground">{agent.role}</span> : null}
    </li>
  )
}

export default function AgentsPage(): React.JSX.Element {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [dialogOpen, setDialogOpen] = useState(false)
  // The canonical project list, from the store that already owns it. Not a second source: the
  // grouping below is a projection over it and the roster, computed per render and never written.
  const projects = useAppStore((s) => s.projects)
  // `activeRepoId`, not `lastActiveRepoId`. The latter is a PersistedUIState key and is not on
  // AppState, so the first version of this line read `undefined` on every render and the default
  // project was silently always null. The node typecheck does not cover the renderer and the dialog
  // test takes `defaultProjectId` as a prop, so neither could see it — only the web typecheck did.
  const activeRepoId = useAppStore((s) => s.activeRepoId)

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

  const defaultProjectId = useMemo(
    () => resolveDefaultProjectId(activeRepoId, projects),
    [activeRepoId, projects]
  )

  const groups = useMemo(
    () => (state.status === 'ready' ? groupAgentsByProject(state.agents, projects) : []),
    [state, projects]
  )

  const onCreated = useCallback(
    (agent: Agent) => {
      // Re-read rather than splicing the new agent in locally: main owns the roster, and a list
      // assembled in the renderer would drift from it the first time a write was refused.
      void refresh()
      void agent
    },
    [refresh]
  )

  return (
    <div className="flex h-full min-h-0 w-full flex-col" data-testid="agents-page">
      <header className="flex items-start justify-between gap-4 border-b border-border px-6 py-4">
        <div>
          <h1 className="text-lg font-medium" tabIndex={-1} data-testid="agents-page-heading">
            {translate('agents.pageTitle', 'Agents')}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {translate(
              'agents.pageSubtitle',
              'People you keep. An agent stays between sessions; a chat does not.'
            )}
          </p>
        </div>
        <Button
          type="button"
          onClick={() => setDialogOpen(true)}
          data-testid="agents-new"
          // Enabled with no projects on purpose: "no project" is a legal, deliberate choice, so
          // there is no prerequisite to explain and no state in which this button would fail.
        >
          {translate('agents.new', 'New agent')}
        </Button>
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

        {groups.map((group) => (
          <section
            key={
              group.kind === 'project'
                ? `project:${group.project.id}`
                : group.kind === 'unresolved'
                  ? `unresolved:${group.projectId}`
                  : 'none'
            }
            className="mb-4"
            data-testid="agents-group"
            data-group-kind={group.kind}
          >
            <h2 className="mb-1 text-xs font-medium uppercase text-muted-foreground">
              {group.kind === 'project'
                ? group.project.displayName
                : group.kind === 'none'
                  ? translate('agents.group.noProject', 'No project')
                  : // Named, not hidden and not relabelled: this agent's owner cannot be found
                    // right now, which is a thing to say rather than an ownership change to invent.
                    translate('agents.group.unresolved', 'Project unavailable')}
            </h2>
            <ul className="flex flex-col gap-1" data-testid="agents-list">
              {group.agents.map((agent) => (
                <AgentRow key={agent.id} agent={agent} />
              ))}
            </ul>
          </section>
        ))}
      </div>

      <NewAgentDialog
        open={dialogOpen}
        projects={projects}
        defaultProjectId={defaultProjectId}
        onOpenChange={setDialogOpen}
        onCreated={onCreated}
      />
    </div>
  )
}
