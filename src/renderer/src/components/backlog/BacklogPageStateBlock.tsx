import { CircleHelp, Inbox, Loader2, Lock, Plus, TriangleAlert, Unplug } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

export type BacklogBlockStatus =
  | 'loading'
  | 'empty'
  | 'filter-empty'
  | 'storage-failed'
  | 'capability-unsupported'
  | 'forbidden'
  | 'unreachable'

export type BacklogFilterEmpty =
  | { reason: 'closed-only'; closedCount: number }
  | { reason: 'filters'; hiddenCount: number }

type BlockCopy = { heading: string; body: string }

function filterEmptyBody(filterEmpty: BacklogFilterEmpty | null): string {
  if (filterEmpty?.reason === 'closed-only') {
    return translate(
      'backlog.status.filterEmpty.closedOnly',
      'No open items. {{closed}} closed items are hidden.',
      { closed: filterEmpty.closedCount }
    )
  }
  return translate(
    'backlog.status.filterEmpty.body',
    '{{hidden}} items are hidden by the current filters.',
    { hidden: filterEmpty?.hiddenCount ?? 0 }
  )
}

function copyFor(
  status: Exclude<BacklogBlockStatus, 'loading'>,
  filterEmpty: BacklogFilterEmpty | null
): BlockCopy {
  switch (status) {
    case 'empty':
      return {
        heading: translate('backlog.status.empty.heading', 'Your backlog is empty'),
        body: translate(
          'backlog.status.empty.body',
          'Capture an idea, a task or a decision, with or without a project.'
        )
      }
    case 'filter-empty':
      return {
        heading: translate('backlog.status.filterEmpty.heading', 'No items match these filters'),
        body: filterEmptyBody(filterEmpty)
      }
    case 'storage-failed':
      return {
        heading: translate('backlog.status.storageFailed.heading', 'Backlog could not be read'),
        body: translate(
          'backlog.status.storageFailed.body',
          'Reading the ledger on this host failed, and nothing was changed. Retry, and if it keeps failing, restart Orca.'
        )
      }
    case 'capability-unsupported':
      return {
        heading: translate(
          'backlog.status.capabilityUnsupported.heading',
          'This Orca host does not provide a Backlog'
        ),
        body: translate(
          'backlog.status.capabilityUnsupported.body',
          'The active host runs an older Orca. Update Orca on that host, or switch to a host that has Backlog.'
        )
      }
    case 'forbidden':
      return {
        heading: translate(
          'backlog.status.forbidden.heading',
          'Backlog is not available on this connection'
        ),
        body: translate(
          'backlog.status.forbidden.body',
          "This connection's access does not include the Backlog. Open it from the desktop app."
        )
      }
    case 'unreachable':
      return {
        heading: translate(
          'backlog.status.unreachable.heading',
          'This Orca host could not be reached'
        ),
        body: translate(
          'backlog.status.unreachable.body',
          'The Backlog lives on the active host. Check the connection, then retry.'
        )
      }
  }
}

function BlockIcon({ status }: { status: Exclude<BacklogBlockStatus, 'loading'> }): React.JSX.Element {
  switch (status) {
    case 'empty':
    case 'filter-empty':
      return <Inbox className="size-7 text-muted-foreground" aria-hidden />
    case 'storage-failed':
      return <TriangleAlert className="size-7 text-destructive" aria-hidden />
    case 'capability-unsupported':
      return <CircleHelp className="size-7 text-[var(--status-unknown)]" aria-hidden />
    case 'forbidden':
      return <Lock className="size-7 text-muted-foreground" aria-hidden />
    case 'unreachable':
      return <Unplug className="size-7 text-[var(--status-unknown)]" aria-hidden />
  }
}

/** One block per non-ready page status. Failure codes live only in data-* attributes, never in copy. */
export function BacklogPageStateBlock({
  status,
  filterEmpty = null,
  onRetry,
  onCapture
}: {
  status: BacklogBlockStatus
  filterEmpty?: BacklogFilterEmpty | null
  onRetry: () => void
  onCapture: () => void
}): React.JSX.Element {
  if (status === 'loading') {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {translate('backlog.status.loading', 'Loading backlog…')}
      </div>
    )
  }
  const copy = copyFor(status, filterEmpty)
  const critical = status === 'storage-failed'
  const retryable = critical || status === 'unreachable'
  return (
    <div
      role={critical ? 'alert' : undefined}
      className={cn(
        'mx-auto my-16 flex max-w-md flex-col items-center gap-2 text-center',
        critical && 'rounded-md border border-destructive/40 bg-destructive/10 px-4 py-4'
      )}
    >
      <BlockIcon status={status} />
      <h2
        className={cn(
          'text-lg font-medium leading-6',
          critical ? 'text-destructive' : 'text-foreground'
        )}
      >
        {copy.heading}
      </h2>
      <p className="text-sm text-muted-foreground">{copy.body}</p>
      {retryable ? (
        <Button variant="outline" size="sm" data-backlog-action="retry" onClick={onRetry}>
          {translate('backlog.status.retry', 'Retry loading')}
        </Button>
      ) : null}
      {status === 'empty' ? (
        <Button size="sm" data-backlog-action="capture-empty" onClick={onCapture}>
          <Plus className="size-4" aria-hidden />
          {translate('backlog.capture.submit', 'Capture item')}
        </Button>
      ) : null}
    </div>
  )
}
