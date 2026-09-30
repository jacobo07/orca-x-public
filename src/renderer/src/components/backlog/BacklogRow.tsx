import { FlaskConical, Lightbulb, ListChecks, Scale, Wrench, type LucideIcon } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import { backlogSourceLabel } from '@/lib/backlog-source-labels'
import { Badge } from '@/components/ui/badge'
import type { BacklogItemSummary } from '../../../../shared/backlog-summary'
import type { BacklogItemKind } from '../../../../shared/backlog-types'
import {
  backlogKindLabel,
  backlogPriorityLabel,
  backlogStateLabel,
  backlogStateTone
} from './backlog-presentation'
import { BacklogStateMark } from './BacklogStateMark'

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

function Chip({ name, children }: { name: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <Badge variant="outline" data-backlog-chip={name} className={CHIP_CLASS}>
      {children}
    </Badge>
  )
}

export function BacklogRow({ row }: { row: BacklogItemSummary }): React.JSX.Element {
  const Icon = KIND_ICON[row.kind] ?? Lightbulb
  const lines = textLines(row.originalText)
  const intent = row.normalizedIntent.trim()
  const title = intent !== '' ? intent : (lines[0] ?? '')
  const secondary = lines[1] ?? backlogKindLabel(row.kind)
  const source = row.sourceLinks[0]?.kind
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
        <p className="truncate text-xs text-muted-foreground">
          <span data-backlog-row-secondary="">{secondary}</span>
          {row.textTruncated ? (
            <span className="ml-1 italic">
              {translate('backlog.row.textShortened', '(text shortened)')}
            </span>
          ) : null}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {source ? <Chip name="source">{backlogSourceLabel(source)}</Chip> : null}
        <Chip name="state">
          <BacklogStateMark tone={backlogStateTone(row.state)} />
          {backlogStateLabel(row.state)}
        </Chip>
        {row.priority !== 'normal' ? (
          <Chip name="priority">{backlogPriorityLabel(row.priority)}</Chip>
        ) : null}
        {inferred ? (
          <Chip name="inferred">{translate('backlog.row.inferred', 'inferred')}</Chip>
        ) : null}
        {projectCount > 1 ? (
          <Chip name="projects">
            {projectCount - 1 === 1
              ? translate('backlog.row.moreProjects_one', '+{{count}} project', { count: 1 })
              : translate('backlog.row.moreProjects_other', '+{{count}} projects', {
                  count: projectCount - 1
                })}
          </Chip>
        ) : null}
        <span className="text-xs tabular-nums text-muted-foreground">
          {formatUiRelativeTime(row.updatedAt - Date.now())}
        </span>
      </div>
    </div>
  )
}
