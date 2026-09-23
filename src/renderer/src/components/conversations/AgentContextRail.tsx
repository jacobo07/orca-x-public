import { Activity, Bot, Folder, Server } from 'lucide-react'
import type { ReactNode } from 'react'

import { translate } from '@/i18n/i18n'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import { cn } from '@/lib/utils'
import type { WorkspaceAgentRow } from '../../../../shared/cognitive-workspace-projection'
import type { ConversationTurn, ConversationTurnState } from '../../../../shared/conversation-types'

import {
  describeProvider,
  describeTurnLocation,
  type GroundingFact,
  type GroundingTone
} from './agent-grounding-presentation'
import type { AgentGroundingLookup } from './use-agent-grounding'
import { projectRefLabel } from './workspace-roster-rows'

const TONE_TEXT: Record<GroundingTone, string> = {
  ready: 'text-[var(--status-success)]',
  caution: 'text-foreground',
  refused: 'text-destructive',
  neutral: 'text-foreground'
}

const TURN_STATE_LABEL: Record<ConversationTurnState, () => string> = {
  pending: () => translate('workspace.turn.pending', 'Pending'),
  working: () => translate('workspace.turn.working', 'Working'),
  completed: () => translate('workspace.turn.completed', 'Completed'),
  interrupted: () => translate('workspace.turn.interrupted', 'Interrupted'),
  failed: () => translate('workspace.turn.failed', 'Failed')
}

export function ContextCard({
  icon,
  title,
  testId,
  children
}: {
  icon: ReactNode
  title: string
  testId: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <section className="rounded-lg border border-border bg-card p-3" data-testid={testId}>
      <h2 className="mb-2 flex items-center gap-2 text-sm font-medium">
        {icon}
        {title}
      </h2>
      <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-2 gap-y-1.5 text-xs">
        {children}
      </dl>
    </section>
  )
}

export function ContextRow({
  term,
  children,
  testId,
  state
}: {
  term: string
  children: ReactNode
  testId?: string
  /** Locale-free machine state of the row, or 'pending' while its owner has not answered. */
  state?: string
}): React.JSX.Element {
  return (
    <>
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="min-w-0 break-words" data-testid={testId} data-state={state}>
        {children}
      </dd>
    </>
  )
}

function Fact({ fact }: { fact: GroundingFact }): React.JSX.Element {
  return (
    <span className="flex flex-col">
      <span className={cn(TONE_TEXT[fact.tone])}>{fact.label}</span>
      {fact.detail ? <span className="text-muted-foreground">{fact.detail}</span> : null}
    </span>
  )
}

const iconClass = 'size-4 text-muted-foreground'

/**
 * What this agent is grounded in, each field from the owner that decides it: the project relation
 * from the roster, location and credential from the turn runner's resolver, activity from the
 * conversation record. Fields nobody produces — model, memory, uptime, tasks — are not shown; the
 * model row says plainly that Orca does not record one.
 */
export function AgentContextRail({
  row,
  grounding,
  turns,
  liveTurnState,
  children
}: {
  row: WorkspaceAgentRow | null
  grounding: AgentGroundingLookup | null
  turns: readonly ConversationTurn[]
  liveTurnState: 'idle' | 'working'
  children?: ReactNode
}): React.JSX.Element {
  const found =
    grounding?.status === 'loaded' && grounding.grounding.outcome === 'found'
      ? grounding.grounding
      : null
  const location = found ? describeTurnLocation(found.location) : null
  const provider = found ? describeProvider(found.provider) : null
  const pending = translate('workspace.context.reading', 'Reading…')
  const groundingProblem =
    grounding?.status === 'failed'
      ? grounding.reason
      : grounding?.status === 'loaded' && grounding.grounding.outcome === 'roster-unreadable'
        ? grounding.grounding.reason
        : grounding?.status === 'loaded' && grounding.grounding.outcome === 'agent-missing'
          ? translate('workspace.context.agentMissing', 'This agent is no longer in your roster.')
          : null
  const recentTurns = [...turns].sort((left, right) => right.seq - left.seq).slice(0, 5)

  return (
    <aside
      className="scrollbar-sleek flex w-80 shrink-0 flex-col gap-3 overflow-y-auto border-l border-border bg-background p-3"
      aria-label={translate('workspace.context.label', 'Agent context')}
      data-testid="agent-context-rail"
    >
      {groundingProblem !== null ? (
        <p className="text-xs text-destructive" role="alert" data-testid="agent-context-error">
          {groundingProblem}
        </p>
      ) : null}

      <ContextCard
        icon={<Folder className={iconClass} aria-hidden />}
        title={translate('workspace.context.project', 'Project')}
        testId="agent-context-project"
      >
        <ContextRow
          term={translate('workspace.context.name', 'Name')}
          testId="agent-context-project-name"
          state={row?.project.kind ?? 'pending'}
        >
          {row ? projectRefLabel(row.project) : pending}
        </ContextRow>
        {found && found.location.outcome === 'resolved' ? (
          <ContextRow term={translate('workspace.context.path', 'Path')}>
            <span className="font-mono">{found.location.path}</span>
          </ContextRow>
        ) : null}
      </ContextCard>

      <ContextCard
        icon={<Server className={iconClass} aria-hidden />}
        title={translate('workspace.context.execution', 'Execution')}
        testId="agent-context-execution"
      >
        <ContextRow
          term={translate('workspace.context.runsOn', 'Next turn')}
          testId="agent-context-location"
          state={found?.location.outcome ?? 'pending'}
        >
          {location ? <Fact fact={location} /> : pending}
        </ContextRow>
        <ContextRow
          term={translate('workspace.context.provider', 'Provider')}
          testId="agent-context-provider"
        >
          {provider ? provider.driver : pending}
        </ContextRow>
        <ContextRow
          term={translate('workspace.context.credential', 'Credential')}
          testId="agent-context-credential"
          state={found?.provider.credential.state ?? 'pending'}
        >
          {provider ? <Fact fact={provider.credential} /> : pending}
        </ContextRow>
        <ContextRow
          term={translate('workspace.context.model', 'Model')}
          testId="agent-context-model"
        >
          <span className="text-muted-foreground">
            {translate('workspace.context.modelUnrecorded', 'Chosen by the provider; not recorded')}
          </span>
        </ContextRow>
      </ContextCard>

      <ContextCard
        icon={<Bot className={iconClass} aria-hidden />}
        title={translate('workspace.context.agent', 'Agent')}
        testId="agent-context-agent"
      >
        <ContextRow term={translate('workspace.context.role', 'Role')}>
          {row?.agent.role || '—'}
        </ContextRow>
        <ContextRow
          term={translate('workspace.context.threads', 'Threads')}
          testId="agent-context-threads"
        >
          {row ? String(row.threadCount) : pending}
        </ContextRow>
        <ContextRow term={translate('workspace.context.lastActivity', 'Last activity')}>
          {row?.lastActivityAt != null
            ? formatUiRelativeTime(row.lastActivityAt - Date.now())
            : translate('workspace.context.never', 'None yet')}
        </ContextRow>
        <ContextRow term={translate('workspace.context.now', 'Now')} testId="agent-context-now">
          {liveTurnState === 'working'
            ? translate('workspace.turn.working', 'Working')
            : translate('workspace.context.idle', 'Idle')}
        </ContextRow>
      </ContextCard>

      <ContextCard
        icon={<Activity className={iconClass} aria-hidden />}
        // Provider turns, not messages: a send refused before the provider (sign-in, a missing
        // project) keeps the user's message but starts no turn, so "nothing asked" would be false.
        title={translate('workspace.context.activity', 'Provider turns in this thread')}
        testId="agent-context-activity"
      >
        {recentTurns.length === 0 ? (
          <ContextRow term="—">
            <span className="text-muted-foreground">
              {translate('workspace.context.noTurns', 'None has reached the provider yet')}
            </span>
          </ContextRow>
        ) : (
          recentTurns.map((turn) => (
            <ContextRow key={turn.turnId} term={formatUiRelativeTime(turn.startedAt - Date.now())}>
              {TURN_STATE_LABEL[turn.state]()}
            </ContextRow>
          ))
        )}
      </ContextCard>

      {children}
    </aside>
  )
}
