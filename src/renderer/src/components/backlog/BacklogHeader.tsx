import { Plus, X } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ClaimValue } from './ClaimValue'

export type BacklogHeaderCounts = { openTotal: number; openProjectCount: number }

function OpenTotal({ value }: { value: number }): React.JSX.Element {
  return (
    <span data-backlog-open-total="" data-count={value}>
      <ClaimValue testId="backlog-open-total" value={value} />{' '}
      {value === 1
        ? translate('backlog.header.openItems_one', 'open item')
        : translate('backlog.header.openItems_other', 'open items')}
    </span>
  )
}

function ProjectTotal({ value }: { value: number }): React.JSX.Element {
  return (
    <span data-backlog-project-total="" data-count={value}>
      <ClaimValue testId="backlog-project-total" value={value} />{' '}
      {value === 1
        ? translate('backlog.header.projects_one', 'project')
        : translate('backlog.header.projects_other', 'projects')}
    </span>
  )
}

/** Header band. Counts are null until a list succeeded: hidden, never zero. Sets no width for anything. */
export function BacklogHeader({
  counts,
  onClose,
  onCapture,
  captureRef
}: {
  counts: BacklogHeaderCounts | null
  onClose: () => void
  onCapture: () => void
  captureRef?: React.Ref<HTMLButtonElement>
}): React.JSX.Element {
  return (
    <header className="flex flex-none flex-wrap items-center gap-x-2 gap-y-1 pb-4 md:flex-nowrap">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 rounded-full"
            data-backlog-action="close"
            onClick={onClose}
            aria-label={translate('backlog.page.close', 'Close backlog')}
          >
            <X className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {translate('backlog.page.closeTooltip', 'Close · Esc')}
        </TooltipContent>
      </Tooltip>
      <div className="mx-1 h-5 w-px bg-border/50" aria-hidden />
      <h1 className="min-w-0 truncate text-lg font-medium leading-6">
        {translate('backlog.page.title', 'Backlog')}
      </h1>
      <p className="order-last w-full min-w-0 truncate text-[12px] text-muted-foreground md:order-none md:w-auto md:flex-1">
        {counts ? (
          <>
            <OpenTotal value={counts.openTotal} /> {translate('backlog.header.across', 'across')}{' '}
            <ProjectTotal value={counts.openProjectCount} />
          </>
        ) : null}
      </p>
      <span className="flex-1 md:hidden" />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button ref={captureRef} size="sm" data-backlog-action="capture" onClick={onCapture}>
            <Plus className="size-4" aria-hidden />
            {translate('backlog.capture.submit', 'Capture item')}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6} className="flex items-center gap-2">
          {translate('backlog.capture.submit', 'Capture item')}
          <ShortcutKeyCombo keys={['N']} />
        </TooltipContent>
      </Tooltip>
    </header>
  )
}
