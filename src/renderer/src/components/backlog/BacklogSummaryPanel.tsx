import { CircleHelp } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { BACKLOG_ITEM_KINDS, BACKLOG_ITEM_STATES } from '../../../../shared/backlog-types'
import type { BacklogHealthOutcome } from './backlog-client'
import { backlogKindLabel, backlogStateLabel, backlogStateTone } from './backlog-presentation'
import { BacklogDelayedLoader } from './BacklogPageStateBlock'
import { BacklogStateMark } from './BacklogStateMark'
import { ClaimValue } from './ClaimValue'

type HealthReport = Extract<BacklogHealthOutcome, { status: 'ok' }>['report']

const ROW = 'flex items-center justify-between gap-2 py-1'
const LABEL = 'min-w-0 truncate text-[12px] text-muted-foreground'
const VALUE = 'flex items-center gap-1.5 text-[12px] font-medium tabular-nums'

function SectionHeading({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <h3 className="pb-1 text-[12px] font-medium text-foreground">{children}</h3>
}

function OpenByKind({ report }: { report: HealthReport }): React.JSX.Element {
  // An older host omits openByKind: each kind states "not recorded", never 0 (R-04).
  const openByKind = report.items.openByKind
  return (
    <section>
      <SectionHeading>{translate('backlog.summary.openByKind', 'Open by kind')}</SectionHeading>
      <dl data-backlog-summary-kinds="">
        {BACKLOG_ITEM_KINDS.map((kind) =>
          openByKind ? (
            <div
              key={kind}
              className={ROW}
              data-backlog-summary-kind={kind}
              data-count={openByKind[kind]}
            >
              <dt className={LABEL}>{backlogKindLabel(kind)}</dt>
              <dd className={VALUE}>
                <ClaimValue testId="backlog-summary-kind-count" value={openByKind[kind]} />
              </dd>
            </div>
          ) : (
            <div
              key={kind}
              className={ROW}
              data-backlog-summary-kind={kind}
              data-count-status="unknown"
            >
              <dt className={LABEL}>{backlogKindLabel(kind)}</dt>
              <dd className={`${VALUE} text-muted-foreground`}>
                <BacklogStateMark tone="unknown" />
                {translate('backlog.summary.notRecorded', 'not recorded')}
              </dd>
            </div>
          )
        )}
      </dl>
    </section>
  )
}

function ByState({ report }: { report: HealthReport }): React.JSX.Element {
  const states = BACKLOG_ITEM_STATES.filter((state) => (report.items.byState[state] ?? 0) > 0)
  return (
    <section>
      <SectionHeading>{translate('backlog.summary.byState', 'By state')}</SectionHeading>
      <dl>
        {states.map((state) => (
          <div
            key={state}
            className={ROW}
            data-backlog-summary-state={state}
            data-count={report.items.byState[state]}
          >
            <dt className={`${LABEL} flex items-center gap-1.5`}>
              <BacklogStateMark tone={backlogStateTone(state)} />
              {backlogStateLabel(state)}
            </dt>
            <dd className={VALUE}>
              <ClaimValue
                testId="backlog-summary-state-count"
                value={report.items.byState[state]}
              />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

function Totals({ report }: { report: HealthReport }): React.JSX.Element {
  const quarantined = report.quarantined.length
  return (
    <dl>
      <div className={ROW} data-backlog-summary-total="" data-count={report.items.total}>
        <dt className={LABEL}>{translate('backlog.summary.total', 'Total items')}</dt>
        <dd className="text-sm font-medium tabular-nums">
          <ClaimValue testId="backlog-summary-total" value={report.items.total} />
        </dd>
      </div>
      {quarantined > 0 ? (
        <div className={ROW} data-backlog-summary-quarantined="" data-count={quarantined}>
          <dt className={`${LABEL} flex items-center gap-1.5`}>
            <BacklogStateMark tone="critical" />
            {translate('backlog.summary.quarantined', 'Records that could not be read')}
          </dt>
          <dd className={VALUE}>
            <ClaimValue testId="backlog-summary-quarantined" value={quarantined} />
          </dd>
        </div>
      ) : null}
    </dl>
  )
}

/** R5: the ledger's own health counts. A failed read says so; the list beside it stays. */
export function BacklogSummaryPanel({
  health,
  onRetry
}: {
  health: BacklogHealthOutcome | null
  onRetry: () => void
}): React.JSX.Element {
  const status = health === null ? 'loading' : health.status === 'ok' ? 'ready' : 'unavailable'
  return (
    <aside
      aria-label={translate('backlog.summary.title', 'Backlog summary')}
      data-backlog-summary=""
      data-backlog-summary-status={status}
      className="scrollbar-sleek max-h-[40vh] w-full shrink-0 overflow-y-auto lg:max-h-none lg:w-72"
    >
      <div className="rounded-xl border border-border bg-card p-4">
        <h2 className="text-sm font-medium">
          {translate('backlog.summary.title', 'Backlog summary')}
        </h2>
        {health === null ? (
          <BacklogDelayedLoader label={translate('backlog.summary.loading', 'Loading summary…')} />
        ) : health.status === 'ok' ? (
          <>
            <Separator className="my-4" />
            <OpenByKind report={health.report} />
            <Separator className="my-4" />
            <ByState report={health.report} />
            <Separator className="my-4" />
            <Totals report={health.report} />
          </>
        ) : (
          <div
            data-backlog-notice="summary-unavailable"
            className="flex flex-col items-start gap-2 pt-4 text-[12px] text-muted-foreground"
          >
            <p className="flex items-start gap-1.5">
              <CircleHelp
                className="mt-0.5 size-3.5 shrink-0 text-[var(--status-unknown)]"
                aria-hidden
              />
              {translate(
                'backlog.summary.unavailable',
                'Summary unavailable. The item list above is still current.'
              )}
            </p>
            <Button
              variant="outline"
              size="sm"
              data-backlog-action="retry-summary"
              onClick={onRetry}
            >
              {translate('backlog.summary.retry', 'Retry summary')}
            </Button>
          </div>
        )}
      </div>
    </aside>
  )
}
