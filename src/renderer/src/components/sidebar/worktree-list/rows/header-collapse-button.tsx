import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { handleRepoHeaderCollapseAffordancePointerDown } from './header-event-guards'

/**
 * The expand/collapse control on a sidebar section header.
 *
 * A real button rather than decoration: on a project header the row itself opens the project, so
 * this is the only control that expands and collapses, and it has to carry that state and a name
 * of its own.
 */
export function HeaderCollapseButton({
  collapsed,
  label,
  onToggle
}: {
  collapsed: boolean
  label: string
  onToggle: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
      data-repo-header-collapse-affordance=""
      aria-expanded={!collapsed}
      aria-label={
        collapsed
          ? translate('auto.components.sidebar.SectionHeader.expandGroup', 'Expand {{label}}', {
              label
            })
          : translate('auto.components.sidebar.SectionHeader.collapseGroup', 'Collapse {{label}}', {
              label
            })
      }
      onPointerDown={handleRepoHeaderCollapseAffordancePointerDown}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onToggle()
      }}
    >
      <ChevronDown className={cn('size-3.5 transition-transform', collapsed && '-rotate-90')} />
    </button>
  )
}
