import { translate } from '@/i18n/i18n'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'

import { describeRunningSessionLiveness, type RunningSessionTone } from './running-session-presentation'
import type { WorkspaceRunningSession } from './workspace-running-sessions'
import { AgentMonogram } from './workspace-roster-rows'

const TONE_DOT: Record<RunningSessionTone, string> = {
  ready: 'bg-[var(--status-success)]',
  caution: 'bg-[var(--status-warning)]',
  refused: 'bg-destructive',
  neutral: 'bg-muted-foreground/60'
}

/** Leaves Workspace for the pane itself, the way the agent board reveals a card. */
function revealSession(session: WorkspaceRunningSession): void {
  const store = useAppStore.getState()
  if (!store.setActiveWorktree(session.reveal.worktreeId, session.reveal.executionHostId)) {
    return
  }
  store.setActiveView('terminal')
  activateTabAndFocusPane(session.reveal.tabId, session.reveal.leafId, { flashFocusedPane: true })
}

/**
 * Agents already running in Orca's terminals, on any host. They are terminal sessions, not agent
 * records: they are opened where they run, not chatted with here, and they are never merged into
 * "Your agents" — nothing binds one to the other.
 */
export function RunningSessionsSection({
  sessions
}: {
  sessions: readonly WorkspaceRunningSession[]
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-1" data-testid="workspace-running-sessions">
      <h2 className="px-2 text-xs font-medium text-muted-foreground">
        {translate('workspace.sessions.heading', 'Running in terminals')}
      </h2>
      {sessions.length === 0 ? (
        <p className="px-2 text-xs text-muted-foreground" data-testid="workspace-running-sessions-none">
          {translate('workspace.sessions.none', 'No agent is running in a terminal.')}
        </p>
      ) : null}
      <ul className="flex flex-col gap-0.5">
        {sessions.map((session) => {
          const liveness = describeRunningSessionLiveness(session.liveness)
          return (
            <li key={session.paneKey}>
              <button
                type="button"
                onClick={() => revealSession(session)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
                data-testid="workspace-running-session"
                data-pane-key={session.paneKey}
                data-host-id={session.hostId}
                data-liveness={session.liveness}
              >
                <AgentMonogram name={session.agentType} className="size-7" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{session.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {session.agentType} · {session.hostLabel} · {session.worktreeName}
                  </span>
                </span>
                <span
                  className={cn('size-2 shrink-0 rounded-full', TONE_DOT[liveness.tone])}
                  role="img"
                  aria-label={liveness.label}
                  title={liveness.label}
                />
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
