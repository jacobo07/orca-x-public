import { CircleHelp, TriangleAlert } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type { BacklogHealthOutcome } from './backlog-client'
import type { BacklogLoadOutcome } from './backlog-snapshot'
import { ClaimValue } from './ClaimValue'

type ReadyLoad = Extract<BacklogLoadOutcome, { status: 'ready' }>

const BANNER = 'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border px-4 py-2 text-[12px]'
const CRITICAL = 'border-destructive/40 bg-destructive/10 text-foreground'
const UNKNOWN = 'border-border bg-card text-muted-foreground'

function Banner({
  name,
  critical,
  children,
  action
}: {
  name: string
  critical: boolean
  children: React.ReactNode
  action: React.ReactNode
}): React.JSX.Element {
  const Icon = critical ? TriangleAlert : CircleHelp
  return (
    <div data-backlog-notice={name} className={cn(BANNER, critical ? CRITICAL : UNKNOWN)}>
      <Icon
        className={cn(
          'size-3.5 shrink-0',
          critical ? 'text-destructive' : 'text-[var(--status-unknown)]'
        )}
        aria-hidden
      />
      <p className="min-w-0 flex-1">{children}</p>
      {action}
    </div>
  )
}

/**
 * R3: partial or inconsistent reads stated, never hidden. Failure stage and code never reach this
 * text; the quarantine report leaves the page only when the person asks for it.
 */
export function BacklogNotices({
  load,
  health,
  refreshFailed,
  onRetry
}: {
  load: ReadyLoad | null
  health: BacklogHealthOutcome | null
  refreshFailed: boolean
  onRetry: () => void
}): React.JSX.Element | null {
  const quarantined = health?.status === 'ok' ? health.report.quarantined : []
  const mismatch = load !== null && load.rows.length !== load.ledgerTotal
  if (!refreshFailed && quarantined.length === 0 && !mismatch) {
    return null
  }
  return (
    <div className="flex flex-none flex-col gap-2 pb-4">
      {refreshFailed ? (
        <Banner
          name="refresh-failed"
          critical={false}
          action={
            <Button variant="outline" size="sm" data-backlog-action="retry" onClick={onRetry}>
              {translate('backlog.notice.retry', 'Retry')}
            </Button>
          }
        >
          {translate(
            'backlog.notice.refreshFailed',
            'The list could not be refreshed. What you see is from the last successful read.'
          )}
        </Banner>
      ) : null}
      {quarantined.length > 0 ? (
        <Banner
          name="quarantined"
          critical
          action={
            <Button
              variant="outline"
              size="sm"
              data-backlog-action="copy-quarantine"
              onClick={() =>
                void navigator.clipboard.writeText(JSON.stringify(quarantined, null, 2))
              }
            >
              {translate('backlog.notice.copyQuarantine', 'Copy quarantine report')}
            </Button>
          }
        >
          <ClaimValue testId="backlog-notice-quarantined-count" value={quarantined.length} />{' '}
          {translate(
            'backlog.notice.quarantined',
            'records could not be read (items and candidates) and are left out of every count on this page.'
          )}
        </Banner>
      ) : null}
      {mismatch && load ? (
        <Banner
          name="count-mismatch"
          critical={false}
          action={
            <Button variant="outline" size="sm" data-backlog-action="reconcile" onClick={onRetry}>
              {translate('backlog.notice.retry', 'Retry')}
            </Button>
          }
        >
          {translate('backlog.notice.mismatchLoaded', 'Loaded')}{' '}
          <ClaimValue testId="backlog-notice-snapshot-count" value={load.rows.length} />{' '}
          {translate('backlog.notice.mismatchReports', 'items but the ledger reports')}{' '}
          <ClaimValue testId="backlog-notice-ledger-total" value={load.ledgerTotal} />
          {translate('backlog.notice.mismatchReconcile', '. Refresh to reconcile.')}
        </Banner>
      ) : null}
    </div>
  )
}
