import { AgentStateDot } from '@/components/AgentStateDot'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { AgentStatusState } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { TerminalTabLeadingIcon } from '../tab-bar/TerminalTabLeadingIcon'
import type { TerminalTabActivityStatus } from '../tab-bar/terminal-tab-activity-status'
import type { TuiAgent } from '../../../../shared/tui-agent'

/**
 * One row of the rail. Two shapes, one file, because they differ by two lines and splitting them
 * would let their selected/hover treatment drift.
 *
 * Status is passed in, never derived here. The rail is a view of runtime truth; a row that inferred
 * its own state would be a second opinion about whether an agent is working.
 */

export function TerminalRailTabRow({
  tab,
  agent,
  activityStatus,
  paneCount,
  isActive,
  hasUnreadActivity,
  onSelect,
  onContextMenu
}: {
  tab: Pick<TerminalTab, 'id' | 'title' | 'customTitle' | 'shellOverride'>
  agent: TuiAgent | null
  activityStatus: TerminalTabActivityStatus
  paneCount: number
  isActive: boolean
  hasUnreadActivity: boolean
  onSelect: () => void
  onContextMenu: (event: React.MouseEvent<HTMLElement>) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-terminal-rail-row=""
      data-terminal-rail-row-kind="tab"
      data-terminal-rail-tab-id={tab.id}
      {...(isActive ? { 'data-active': '' } : {})}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      title={tab.customTitle ?? tab.title}
      className={cn(
        'flex w-full items-center gap-2 rounded-[6px] px-2 py-1 text-left text-[12px] leading-5',
        'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
        isActive && 'bg-accent text-foreground'
      )}
    >
      <TerminalTabLeadingIcon
        agent={agent}
        activityStatus={activityStatus}
        shell={tab.shellOverride}
        showUnreadActivity={hasUnreadActivity}
        isActive={isActive}
      />
      <span className="min-w-0 flex-1 truncate">{tab.customTitle ?? tab.title}</span>
      {paneCount > 1 ? (
        <span
          className="shrink-0 tabular-nums opacity-60"
          aria-label={translate(
            'auto.components.terminal.rail.TerminalRail.paneCount',
            'Panes in this terminal'
          )}
        >
          {paneCount}
        </span>
      ) : null}
    </button>
  )
}

export function TerminalRailPaneRow({
  label,
  agentState,
  isActive,
  onSelect,
  onContextMenu
}: {
  label: string
  /** Null when this pane has no agent status — a shell has none, and inventing one would lie. */
  agentState: AgentStatusState | null
  isActive: boolean
  onSelect: () => void
  onContextMenu: (event: React.MouseEvent<HTMLElement>) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-terminal-rail-row=""
      data-terminal-rail-row-kind="pane"
      {...(isActive ? { 'data-active': '' } : {})}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      title={label}
      className={cn(
        'flex w-full items-center gap-2 rounded-[6px] py-1 pr-2 pl-6 text-left text-[12px] leading-5',
        'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
        isActive && 'bg-accent text-foreground'
      )}
    >
      <span className="flex size-3 shrink-0 items-center justify-center">
        {agentState ? <AgentStateDot state={agentState} /> : null}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  )
}
