import { ChevronRight, Copy, SquareTerminal } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { MissionBrief } from '../../../../shared/mission-brief-types'
import { ClaimValue } from '../resume-center/ClaimValue'

/**
 * The recommended next command. Full geometry is the r02 reference's
 * (docs/visual/references/mission-brief); its chevron opens the full path.
 */
export function MissionBriefNextActionCard({
  brief,
  compact,
  onViewPath
}: {
  brief: MissionBrief
  compact: boolean
  onViewPath: () => void
}): React.JSX.Element {
  if (brief.nextAction.kind !== 'known') {
    return (
      <ClaimValue testId="mission-brief-next-action">
        {translate('missionBrief.nextAction.unknown', 'Next step unknown')}
      </ClaimValue>
    )
  }
  const command = brief.nextAction.command
  const copy = (
    <button
      type="button"
      className={cn(
        'inline-flex shrink-0 items-center hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        compact
          ? 'gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12px]'
          : 'h-[33px] gap-2 rounded-lg border border-input pr-[11px] pl-3 text-[12px] font-medium'
      )}
      onClick={() => void window.api.ui.writeClipboardText(command)}
    >
      <Copy className={compact ? 'size-3.5' : 'size-[18px]'} aria-hidden />
      {translate('missionBrief.nextAction.copy', 'Copy command')}
    </button>
  )
  if (compact) {
    return (
      <div className="flex items-center gap-4 rounded-lg border border-border bg-muted/20 px-4 py-3">
        <div className="min-w-0 flex-1">
          <ClaimValue testId="mission-brief-next-action" className="block text-[15px] font-medium">
            {brief.nextAction.label}
          </ClaimValue>
          <code className="text-[12px] text-muted-foreground">{command}</code>
        </div>
        {copy}
      </div>
    )
  }
  return (
    <div className="flex h-[66px] items-center rounded-[10px] border border-input bg-muted/40 pr-4 pl-[18px]">
      <SquareTerminal className="mr-4 size-[27px] shrink-0" strokeWidth={1.5} aria-hidden />
      <span
        className="relative top-[2.8px] mr-[15.2px] ml-[0.8px] h-[44px] w-[1.6px] shrink-0 bg-input"
        aria-hidden
      />
      <div className="relative top-[2.8px] min-w-0 flex-1">
        <ClaimValue
          testId="mission-brief-next-action"
          className="block truncate text-[14.8px] leading-[22px] font-medium"
        >
          {brief.nextAction.label}
        </ClaimValue>
        <p
          className="mt-[1.4px] truncate text-[11.8px] leading-[18px] text-muted-foreground"
          title={command}
        >
          {command}
        </p>
      </div>
      {copy}
      <button
        type="button"
        data-testid="mission-brief-next-action-path"
        onClick={onViewPath}
        aria-label={translate('missionBrief.action.viewPath', 'View full path')}
        className="ml-[26px] flex size-5 shrink-0 items-center justify-center rounded-sm text-foreground hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40"
      >
        <ChevronRight className="size-5" strokeWidth={2} aria-hidden />
      </button>
    </div>
  )
}
