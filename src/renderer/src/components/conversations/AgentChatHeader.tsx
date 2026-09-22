import { ArrowLeft } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

import type { ScopedAgentLookup } from './use-scoped-agent'

/**
 * Says who this chat is with. Only what the agent record owns: its name and role — no provider,
 * status or activity, none of which has a producer.
 */
export function AgentChatHeader({
  lookup,
  onBack
}: {
  lookup: ScopedAgentLookup
  onBack: () => void
}): React.JSX.Element {
  return (
    <header
      className="flex items-start gap-3 border-b border-border px-4 py-3"
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
      <div className="min-w-0">
        <h1 className="truncate text-sm font-medium" data-testid="agent-chat-name">
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
    </header>
  )
}
