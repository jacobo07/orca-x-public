import { translate } from '@/i18n/i18n'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import { reachabilityLabel, reachabilityTone } from './workstation-labels'
import { HOST_REACHABILITIES } from '@/lib/host-reachability'
import type { WorkstationSummary } from './workstation-projection'

const ROW = 'flex items-baseline justify-between gap-3 py-1 text-[12px]'

/** Counts from the same projection the cards render; a zero row is omitted, never invented. */
export function WorkstationSummaryPanel({
  summary
}: {
  summary: WorkstationSummary
}): React.JSX.Element {
  return (
    <aside
      aria-label={translate('workstation.summary.title', 'Workstation summary')}
      data-workstation-summary=""
      className="w-full shrink-0 rounded-xl border border-border bg-card p-4"
    >
      <h2 className="text-sm font-medium">
        {translate('workstation.summary.title', 'Workstation summary')}
      </h2>
      <Separator className="my-3" />
      <dl>
        <div className={ROW}>
          <dt>{translate('workstation.summary.hosts', 'Hosts')}</dt>
          <dd className="tabular-nums" data-workstation-summary-hosts={summary.hosts}>
            {summary.hosts}
          </dd>
        </div>
        {HOST_REACHABILITIES.filter((r) => summary.byReachability[r] > 0).map((r) => (
          <div key={r} className={cn(ROW, 'pl-3 text-muted-foreground')}>
            <dt className="flex items-center gap-1.5">
              <span
                aria-hidden
                className={cn('inline-block size-2 rounded-full', reachabilityTone(r))}
              />
              {reachabilityLabel(r)}
            </dt>
            <dd className="tabular-nums" data-workstation-summary-reachability={r}>
              {summary.byReachability[r]}
            </dd>
          </div>
        ))}
      </dl>
      <Separator className="my-3" />
      <dl>
        <div className={ROW}>
          <dt>{translate('workstation.summary.projects', 'Projects set up')}</dt>
          <dd className="tabular-nums" data-workstation-summary-projects={summary.projectsSetUp}>
            {summary.projectsSetUp}
          </dd>
        </div>
        <div className={ROW}>
          <dt>{translate('workstation.summary.agents', 'Agents')}</dt>
          <dd className="tabular-nums" data-workstation-summary-agents={summary.agents}>
            {summary.agents}
          </dd>
        </div>
      </dl>
    </aside>
  )
}
