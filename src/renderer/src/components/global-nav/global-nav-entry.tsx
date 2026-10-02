import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { GlobalNavRow } from './GlobalNavRow'

/** One global-navigation entry: a labeled row when expanded, an icon cell when collapsed. */
export function GlobalNavEntry({
  collapsed,
  id,
  icon,
  label,
  active,
  onSelect,
  structural = false,
  disabled = false,
  hint
}: {
  collapsed: boolean
  id: string
  icon: React.ReactNode
  label: string
  active: boolean
  onSelect: () => void
  /** Chrome control, not a destination: excluded from the destination list the shell gate compares. */
  structural?: boolean
  disabled?: boolean
  /** Why a disabled entry cannot be opened; shown beside the label and in the accessible name. */
  hint?: string
}): React.JSX.Element {
  const dataAttributes: Record<string, string> = structural
    ? { 'data-global-nav-control': id }
    : { 'data-global-nav-item': id }
  const accessibleLabel = hint ? `${label} (${hint})` : label
  if (!collapsed) {
    return (
      <GlobalNavRow
        icon={icon}
        label={label}
        accessibleLabel={accessibleLabel}
        active={active}
        disabled={disabled}
        onSelect={onSelect}
        hint={hint}
        dataAttributes={dataAttributes}
      />
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          {...dataAttributes}
          aria-current={active ? 'page' : undefined}
          aria-disabled={disabled || undefined}
          aria-label={accessibleLabel}
          onClick={disabled ? undefined : onSelect}
          className={cn(
            'relative flex h-10 w-10 shrink-0 items-center justify-center rounded-md transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring',
            active ? 'text-foreground' : 'text-muted-foreground/60 hover:text-muted-foreground',
            disabled && 'cursor-not-allowed opacity-50 hover:text-muted-foreground/60'
          )}
        >
          {icon}
          {active ? (
            <div className="absolute top-[25%] right-0 bottom-[25%] w-[2px] rounded-l bg-foreground" />
          ) : null}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={6}>
        {accessibleLabel}
      </TooltipContent>
    </Tooltip>
  )
}
