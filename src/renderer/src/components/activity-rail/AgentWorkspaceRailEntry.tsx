import React from 'react'
import { useAppStore } from '@/store'
import {
  activeViewForWorkspaceActivity,
  getVisibleWorkspaceActivities
} from './workspace-activity-items'
import {
  ActivityRailItemWithHide,
  WorkspaceActivityRailButton
} from './workspace-activity-rail-button'

/**
 * The agent Workspace entry on its own, for the side panel's strip, where it is drawn directly below
 * Explorer (Owner, 2026-09-24). Same button, gate and hide menu as in the section.
 */
export function AgentWorkspaceRailEntry(): React.JSX.Element | null {
  const settings = useAppStore((s) => s.settings)
  const active = useAppStore(
    (s) => s.activeView === activeViewForWorkspaceActivity('agent-workspace')
  )
  const updateSettings = useAppStore((s) => s.updateSettings)
  const openConversationsPage = useAppStore((s) => s.openConversationsPage)
  if (!getVisibleWorkspaceActivities(settings).includes('agent-workspace')) {
    return null
  }
  return (
    <ActivityRailItemWithHide
      activity="agent-workspace"
      onHide={() => void updateSettings({ showAgentWorkspaceButton: false })}
    >
      <WorkspaceActivityRailButton
        activity="agent-workspace"
        active={active}
        onSelect={openConversationsPage}
      />
    </ActivityRailItemWithHide>
  )
}
