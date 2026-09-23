import { ArrowLeft, Folder, PanelRight, Server } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { WorkspaceProjectRef } from '../../../../shared/cognitive-workspace-projection'

import { describeTurnLocation, type GroundingTone } from './agent-grounding-presentation'
import type { AgentGroundingLookup } from './use-agent-grounding'
import type { ScopedAgentLookup } from './use-workspace-agents'
import { AgentMonogram, projectRefLabel } from './workspace-roster-rows'

const TONE_DOT: Record<GroundingTone, string> = {
  ready: 'bg-[var(--status-success)]',
  caution: 'bg-muted-foreground',
  refused: 'bg-destructive',
  neutral: 'bg-muted-foreground/60'
}

/**
 * Who this chat is with, which project owns it and where its next turn would run. Name and role
 * come from the agent record; project from the agent's project relation; the location chip from
 * the turn runner's own resolver (conversations:agentGrounding). There is no "online" state: an
 * agent is a durable record, not a process, and nothing produces one.
 */
export function AgentChatHeader({
  lookup,
  project,
  grounding,
  onBack,
  compact,
  railOpen,
  onToggleRail
}: {
  lookup: ScopedAgentLookup
  project: WorkspaceProjectRef | null
  grounding: AgentGroundingLookup | null
  onBack: () => void
  /** The location chip keeps its icon and dot; its words move to the tooltip and screen readers. */
  compact: boolean
  railOpen: boolean
  onToggleRail: () => void
}): React.JSX.Element {
  const location =
    grounding?.status === 'loaded' && grounding.grounding.outcome === 'found'
      ? describeTurnLocation(grounding.grounding.location)
      : null
  return (
    <header
      className="flex items-center gap-3 border-b border-border px-4 py-3"
      data-testid="agent-chat-header"
      data-agent-id={lookup.status === 'found' ? lookup.agent.id : undefined}
      data-lookup-status={lookup.status}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={onBack}
        aria-label={translate('agents.chat.back', 'Back to agents')}
        data-testid="agent-chat-back"
      >
        <ArrowLeft className="size-4" />
      </Button>
      {lookup.status === 'found' ? (
        <AgentMonogram name={lookup.agent.name} className="size-9" />
      ) : null}
      {/* min-w-24: the chips beside it shrink first, so the name is never the column that gives way. */}
      <div className="min-w-24 flex-1">
        <h1 className="truncate text-base font-semibold" data-testid="agent-chat-name">
          {lookup.status === 'found'
            ? lookup.agent.name
            : lookup.status === 'loading'
              ? translate('agents.chat.loading', 'Loading agent…')
              : translate('agents.chat.unavailable', 'Agent unavailable')}
        </h1>
        {lookup.status === 'found' && lookup.agent.role ? (
          <p className="truncate text-xs text-muted-foreground">{lookup.agent.role}</p>
        ) : null}
        {lookup.status === 'failed' ? (
          <p className="text-xs text-destructive" role="alert">
            {translate('agents.readFailed', 'Could not read your agents.')}
          </p>
        ) : null}
      </div>
      <div className="flex min-w-0 shrink items-center gap-2">
        {project !== null ? (
          <span
            className="flex min-w-0 max-w-48 items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs"
            data-testid="agent-chat-project-chip"
            data-project-kind={project.kind}
          >
            <Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate">{projectRefLabel(project)}</span>
          </span>
        ) : null}
        {location !== null ? (
          <span
            className="flex min-w-0 max-w-56 items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs"
            title={[location.label, location.detail].filter(Boolean).join(' — ')}
            data-testid="agent-chat-location-chip"
            data-tone={location.tone}
            data-outcome={
              grounding?.status === 'loaded' && grounding.grounding.outcome === 'found'
                ? grounding.grounding.location.outcome
                : undefined
            }
          >
            <Server className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span
              className={cn('size-1.5 shrink-0 rounded-full', TONE_DOT[location.tone])}
              aria-hidden
            />
            <span className={compact ? 'sr-only' : 'truncate'}>{location.label}</span>
          </span>
        ) : null}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={onToggleRail}
        aria-pressed={railOpen}
        aria-label={translate('workspace.context.toggle', 'Context')}
        data-testid="workspace-context-toggle"
      >
        <PanelRight className="size-4" />
      </Button>
    </header>
  )
}
