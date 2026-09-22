import { describe, expect, it } from 'vitest'
import {
  WORKSPACE_ACTIVITY_ORDER,
  activeViewForWorkspaceActivity,
  getVisibleWorkspaceActivities
} from './workspace-activity-items'
import type { WorkspaceActivitySettings } from './workspace-activity-items'

/** Nothing set: every default-on activity shows, every opt-in one does not. */
const DEFAULTS: WorkspaceActivitySettings = {}

describe('getVisibleWorkspaceActivities', () => {
  it('shows the four default-on activities and hides the opt-in ones', () => {
    // Arrange / Act
    const visible = getVisibleWorkspaceActivities(DEFAULTS)

    // Assert — matches what SidebarNav gated on before the rail existed.
    expect(visible).toEqual(['workspace', 'tasks', 'automations', 'mobile'])
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
    expect(getVisibleWorkspaceActivities({ showConversationsButton: true })).toContain(
      'conversations'
    )

    // A truthy-looking absence must not switch them on.
    expect(getVisibleWorkspaceActivities({ showArtifactsButton: false })).not.toContain('artifacts')
    expect(getVisibleWorkspaceActivities({ showSkillsButton: false })).not.toContain('skills')
    expect(getVisibleWorkspaceActivities({ experimentalActivity: false })).not.toContain('activity')
    // The one that matters most for a brand-new surface: an unset key is not consent.
    expect(getVisibleWorkspaceActivities({})).not.toContain('conversations')
    expect(getVisibleWorkspaceActivities(null)).not.toContain('conversations')
  })

  it('keeps one canonical order regardless of which activities are enabled', () => {
    const all = getVisibleWorkspaceActivities({
      showArtifactsButton: true,
      showSkillsButton: true,
      showConversationsButton: true,
      showAgentsButton: true,
      experimentalActivity: true
    })

    // The rail's order is a product decision, not an accident of the settings object's key order.
    expect(all).toEqual([...WORKSPACE_ACTIVITY_ORDER])
    // Entry point first, companion surface last.
    expect(all[0]).toBe('workspace')
    expect(all.at(-1)).toBe('mobile')
  })

  it('hides everything when every activity is switched off, without throwing', () => {
    expect(
      getVisibleWorkspaceActivities({
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
    // W-C3B removed the one entry whose view id differed from its activity id: the feed the rail
    // called `agents` was always TopLevelView 'activity', and now the rail says so too.
    expect(activeViewForWorkspaceActivity('activity')).toBe('activity')
    for (const activity of WORKSPACE_ACTIVITY_ORDER) {
      expect(activeViewForWorkspaceActivity(activity)).toBeTruthy()
    }
  })
})
