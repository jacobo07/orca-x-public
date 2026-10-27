import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { TerminalTabLeadingIcon } from './TerminalTabLeadingIcon'
import { TerminalTabSessionResumeButton } from './TerminalTabSessionResumeButton'
import type { TerminalTabActivityStatus } from './terminal-tab-activity-status'

/** A strip tab's identity glyph, with Resume beside it while the tab holds an exited session. */
export function TerminalTabIdentitySlot({
  tab,
  agent,
  activityStatus,
  showUnreadActivity,
  isActive,
  onActivate
}: {
  tab: TerminalTab
  agent: TuiAgent | null
  activityStatus: TerminalTabActivityStatus
  showUnreadActivity: boolean
  isActive: boolean
  onActivate: (tabId: string) => void
}): React.JSX.Element {
  return (
    <>
      <TerminalTabLeadingIcon
        agent={agent}
        activityStatus={activityStatus}
        // Why: shellOverride is stamped at create time, so changing the default shell later won't repaint existing tabs.
        shell={tab.shellOverride}
        showUnreadActivity={showUnreadActivity}
        isActive={isActive}
      />
      <TerminalTabSessionResumeButton tab={tab} isActive={isActive} onActivate={onActivate} />
    </>
  )
}
