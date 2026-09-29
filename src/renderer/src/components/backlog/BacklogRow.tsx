import {
  FlaskConical,
  Lightbulb,
  ListChecks,
  Scale,
  Wrench,
  type LucideIcon
} from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import { Badge } from '@/components/ui/badge'
import type { BacklogItemSummary } from '../../../../shared/backlog-summary'
import type { BacklogItemKind } from '../../../../shared/backlog-types'

const KIND_ICON: Record<BacklogItemKind, LucideIcon> = {
  engineering: Wrench,
  research: FlaskConical,
  decision: Scale,
  manual: ListChecks,
  idea: Lightbulb
}

const CHIP_CLASS = 'font-normal text-muted-foreground'

function textLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

export function BacklogRow({ row }: { row: BacklogItemSummary }): React.JSX.Element {
  const Icon = KIND_ICON[row.kind] ?? Lightbulb
  const lines = textLines(row.originalText)
  const intent = row.normalizedIntent.trim()
  const title = intent !== '' ? intent : (lines[0] ?? '')
  const secondary = lines[1] ?? null
  const projectCount = new Set(row.projectRefs.map((ref) => ref.projectId)).size
  const inferred = row.projectRefs.some((ref) => ref.mapping === 'inferred')
  return (
    <div
      data-backlog-item-id={row.id}
      data-backlog-state={row.state}
      data-backlog-kind={row.kind}
      data-backlog-cross-project={projectCount > 1 ? 'true' : 'false'}
      className="flex min-h-12 flex-wrap items-center gap-x-2 gap-y-1 border-t border-border px-4 py-2 md:flex-nowrap"
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium leading-5" title={row.originalText}>
          {title}
        </p>
        {secondary !== null || row.textTruncated ? (
          <p className="truncate text-xs text-muted-foreground">
            {secondary}
            {row.textTruncated ? (
              <span className="ml-1 italic">
                {translate('backlog.row.textShortened', '(text shortened)')}
              </span>
            ) : null}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {inferred ? (
          <Badge variant="outline" className={CHIP_CLASS}>
            {translate('backlog.row.inferred', 'inferred')}
          </Badge>
        ) : null}
        {projectCount > 1 ? (
          <Badge variant="outline" className={CHIP_CLASS}>
            {projectCount - 1 === 1
              ? translate('backlog.row.moreProjects_one', '+{{count}} project', { count: 1 })
              : translate('backlog.row.moreProjects_other', '+{{count}} projects', {
                  count: projectCount - 1
                })}
          </Badge>
        ) : null}
        <span className="text-xs tabular-nums text-muted-foreground">
          {formatUiRelativeTime(row.updatedAt - Date.now())}
        </span>
      </div>
    </div>
  )
}
