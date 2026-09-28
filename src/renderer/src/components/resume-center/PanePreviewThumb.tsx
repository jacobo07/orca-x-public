import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { describePreviewAbsence } from './resume-center-presentation'
import { usePanePreview } from './use-pane-preview'

// Why a cap: a thumbnail shows the tail of the screen; more lines cost layout for nothing legible.
const MAX_THUMB_LINES = 24

/** A pane's last recorded screen, drawn small. Labelled a snapshot: it is never live output. */
export function PanePreviewThumb({
  hostId,
  tabId,
  leafId,
  enabled,
  title,
  className
}: {
  hostId: string
  tabId: string
  leafId: string | null
  enabled: boolean
  title: string
  className?: string
}): React.JSX.Element {
  const state = usePanePreview({ hostId, tabId, leafId }, enabled)
  const lines =
    state.status === 'done' && state.result.status === 'rendered'
      ? state.result.lines.slice(-MAX_THUMB_LINES)
      : null
  const absence = state.status === 'done' ? describePreviewAbsence(state.result) : null
  return (
    <figure
      data-testid="resume-center-pane-preview"
      data-preview-status={state.status === 'done' ? state.result.status : state.status}
      className={cn(
        'relative flex h-24 w-40 shrink-0 flex-col overflow-hidden rounded-md border border-border bg-background',
        className
      )}
    >
      {lines ? (
        <pre
          aria-label={translate('resumeCenter.preview.label', 'Last recorded screen of {{title}}', {
            title
          })}
          className="flex-1 overflow-hidden px-1.5 pt-1 font-mono text-[5.5px] leading-[7px] text-muted-foreground"
        >
          {lines.join('\n')}
        </pre>
      ) : (
        <div className="flex flex-1 items-center justify-center px-2 text-center text-[11px] text-muted-foreground">
          {state.status === 'done'
            ? absence
            : state.status === 'loading'
              ? translate('resumeCenter.preview.loading', 'Reading…')
              : null}
        </div>
      )}
      <figcaption className="truncate border-t border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
        {lines ? `${translate('resumeCenter.preview.snapshot', 'Snapshot')} · ${title}` : title}
      </figcaption>
    </figure>
  )
}
