import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { ConversationSummary } from '../../../../shared/conversation-summary'

/**
 * Rows are cheap by construction: a summary carries a title, a timestamp and a count, never the
 * message tree. Listing a conversation must not mount its history, and it must not start a
 * provider — history existing is not a reason for anything to be running.
 */
export function ConversationList({
  summaries,
  activeId,
  draftActive,
  loading,
  onSelect,
  onNewChat
}: {
  summaries: readonly ConversationSummary[]
  activeId: string | null
  draftActive: boolean
  loading: boolean
  onSelect: (id: string) => void
  onNewChat: () => void
}): React.JSX.Element {
  return (
    <div className="flex h-full w-64 shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="p-2">
        <Button
          variant="secondary"
          className="w-full justify-start"
          onClick={onNewChat}
          aria-current={draftActive ? 'true' : undefined}
          data-testid="conversations-new-chat"
        >
          {translate('conversations.newChat', 'New chat')}
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <ul className="flex flex-col gap-0.5 p-2 pt-0" data-testid="conversations-list">
          {summaries.map((summary) => (
            <li key={summary.id}>
              <button
                type="button"
                onClick={() => onSelect(summary.id)}
                aria-current={summary.id === activeId ? 'true' : undefined}
                data-testid="conversations-list-row"
                data-conversation-id={summary.id}
                className={cn(
                  'w-full truncate rounded-md px-2 py-1.5 text-left text-sm',
                  'hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  summary.id === activeId && 'bg-sidebar-accent'
                )}
              >
                <ConversationRowLabel summary={summary} />
              </button>
            </li>
          ))}
        </ul>

        {!loading && summaries.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-muted-foreground">
            {translate('conversations.empty', 'No conversations yet.')}
          </p>
        ) : null}
      </ScrollArea>
    </div>
  )
}

/**
 * A record that cannot be read still gets a row. Dropping it would make a conversation the user can
 * see on disk vanish from the product with nothing to ask about — and the next read-modify-write
 * could then publish that emptiness back over it.
 */
function ConversationRowLabel({ summary }: { summary: ConversationSummary }): React.JSX.Element {
  if (summary.outcome === 'unreadable') {
    return (
      <span className="block truncate text-destructive" title={summary.reason}>
        {translate('conversations.rowUnreadable', 'Unreadable conversation')}
      </span>
    )
  }
  if (summary.outcome === 'schema-too-new') {
    return (
      <span className="block truncate text-muted-foreground">
        {translate('conversations.rowTooNew', 'Saved by a newer Orca')}
      </span>
    )
  }
  return (
    <span className="block truncate">
      {summary.title ?? translate('conversations.untitled', 'Untitled')}
    </span>
  )
}
