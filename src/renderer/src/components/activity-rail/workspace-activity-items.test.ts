import { describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  WORKSPACE_ACTIVITY_ORDER,
  activeViewForWorkspaceActivity,
  getVisibleWorkspaceActivities
} from './workspace-activity-items'
import type { WorkspaceActivitySettings } from './workspace-activity-items'

/** Nothing set: every default-on activity shows, every opt-in one does not. */
const DEFAULTS: WorkspaceActivitySettings = {}

describe('getVisibleWorkspaceActivities', () => {
  it('shows the default-on activities, agent Workspace first, and hides the opt-in ones', () => {
    // Arrange / Act
    const visible = getVisibleWorkspaceActivities(DEFAULTS)

    // Assert — the four SidebarNav gated on before the rail existed, led by the agent Workspace.
    expect(visible).toEqual(['agent-workspace', 'workspace', 'tasks', 'automations', 'mobile'])
  })

  it('shows the agent Workspace to a profile still holding the retired Chats and Agents keys', () => {
    // Both retired keys defaulted to false, so a stored false is not a choice to hide anything.
    // Typed as what a real old profile hands the rail: the full settings object.
    const legacy: Partial<GlobalSettings> = {
      showConversationsButton: false,
      showAgentsButton: false
    }
    expect(getVisibleWorkspaceActivities(legacy)).toContain('agent-workspace')
    // The key that does govern it.
    expect(getVisibleWorkspaceActivities({ showAgentWorkspaceButton: false })).not.toContain(
      'agent-workspace'
    )
  })

  it('treats a null or undefined settings object as defaults rather than hiding everything', () => {
    expect(getVisibleWorkspaceActivities(null)).toEqual(getVisibleWorkspaceActivities(DEFAULTS))
    expect(getVisibleWorkspaceActivities(undefined)).toEqual(
      getVisibleWorkspaceActivities(DEFAULTS)
    )
  })

  it('hides a default-on activity only on an explicit false', () => {
    expect(getVisibleWorkspaceActivities({ showTasksButton: false })).not.toContain('tasks')
    expect(getVisibleWorkspaceActivities({ showAutomationsButton: false })).not.toContain(
      'automations'
    )
    expect(getVisibleWorkspaceActivities({ showWorkspaceButton: false })).not.toContain('workspace')
    expect(getVisibleWorkspaceActivities({ showMobileButton: false })).not.toContain('mobile')
  })

  it('shows an opt-in activity only on an explicit true', () => {
    expect(getVisibleWorkspaceActivities({ showArtifactsButton: true })).toContain('artifacts')
    expect(getVisibleWorkspaceActivities({ showSkillsButton: true })).toContain('skills')
    expect(getVisibleWorkspaceActivities({ experimentalActivity: true })).toContain('activity')

    // A truthy-looking absence must not switch them on.
    expect(getVisibleWorkspaceActivities({ showArtifactsButton: false })).not.toContain('artifacts')
    expect(getVisibleWorkspaceActivities({ showSkillsButton: false })).not.toContain('skills')
    expect(getVisibleWorkspaceActivities({ experimentalActivity: false })).not.toContain('activity')
  })

  it('keeps one canonical order regardless of which activities are enabled', () => {
    const all = getVisibleWorkspaceActivities({
      showArtifactsButton: true,
      showSkillsButton: true,
      experimentalActivity: true
    })

    // The rail's order is a product decision, not an accident of the settings object's key order.
    expect(all).toEqual([...WORKSPACE_ACTIVITY_ORDER])
    // Entry point first, companion surface last.
    expect(all[0]).toBe('agent-workspace')
    expect(all.at(-1)).toBe('mobile')
  })

  it('no longer offers the Chats and Agents entries Workspace absorbed', () => {
    // Station control: the same list does contain the entry that replaced them.
    expect(WORKSPACE_ACTIVITY_ORDER).toContain('agent-workspace')
    const ids: readonly string[] = WORKSPACE_ACTIVITY_ORDER
    expect(ids).not.toContain('conversations')
    expect(ids).not.toContain('agents')
  })

  it('hides everything when every activity is switched off, without throwing', () => {
    expect(
      getVisibleWorkspaceActivities({
        showAgentWorkspaceButton: false,
        showWorkspaceButton: false,
        showTasksButton: false,
        showAutomationsButton: false,
        showMobileButton: false
      })
    ).toEqual([])
  })
})

describe('activeViewForWorkspaceActivity', () => {
  it('maps every ordered activity to a top-level view', () => {
    // The agent Workspace is the page the Chats entry opened; its route id never moved.
    expect(activeViewForWorkspaceActivity('agent-workspace')).toBe('conversations')
    expect(activeViewForWorkspaceActivity('activity')).toBe('activity')
    for (const activity of WORKSPACE_ACTIVITY_ORDER) {
      expect(activeViewForWorkspaceActivity(activity)).toBeTruthy()
    }
  })
})
