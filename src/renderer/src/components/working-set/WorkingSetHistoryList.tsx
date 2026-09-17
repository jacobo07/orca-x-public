import { getIntlLocale, translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { problemText } from './working-set-copy'
import type { WorkingSetHistoryRow, WorkingSetProblemRow } from './working-set-history-view'

function formatCapturedAt(createdAt: number): string {
  return new Intl.DateTimeFormat(getIntlLocale(), {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(createdAt)
}

export function WorkingSetHistoryList({
  rows,
  problems,
  selectedId,
  onSelect
}: {
  rows: readonly WorkingSetHistoryRow[]
  problems: readonly WorkingSetProblemRow[]
  selectedId: string | null
  onSelect: (workingSetId: string) => void
}): React.JSX.Element {
  return (
    <div className="scrollbar-sleek flex max-h-72 flex-col gap-2 overflow-y-auto">
      {rows.length > 0 ? (
        <div
          role="radiogroup"
          aria-label={translate('workingSet.history.listLabel', 'Saved snapshots')}
          className="flex flex-col gap-1"
        >
          {rows.map((row) => {
            const selected = row.workingSetId === selectedId
            return (
              <button
                key={row.workingSetId}
                type="button"
                role="radio"
                aria-checked={selected}
                data-testid="working-set-row"
                data-working-set-id={row.workingSetId}
                onClick={() => onSelect(row.workingSetId)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-xs',
                  selected
                    ? 'border-ring bg-accent text-accent-foreground'
                    : 'border-border/50 bg-card/40 hover:bg-accent/50'
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {row.label ?? translate('workingSet.history.untitled', 'Untitled snapshot')}
                  </span>
                  <span className="block text-muted-foreground">
                    {formatCapturedAt(row.createdAt)}
                    {' · '}
                    {translate('workingSet.history.tabCount', 'Tabs: {{count}}', {
                      count: row.tabCount
                    })}
                  </span>
                </span>
                {row.isLatest ? (
                  <span className="shrink-0 rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {translate('workingSet.history.latest', 'Latest')}
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      ) : null}
      {problems.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-[11px] font-medium text-muted-foreground">
            {translate('workingSet.history.problemsTitle', 'Not restorable')}
          </p>
          <ul className="flex flex-col gap-1">
            {problems.map((problem) => (
              <li
                key={problem.key}
                data-testid="working-set-problem"
                data-working-set-problem={problem.kind}
                className="rounded-md border border-dashed border-border/60 px-3 py-1.5 text-[11px] text-muted-foreground"
              >
                {problemText(problem.kind)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
