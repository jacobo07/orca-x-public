import { describe, expect, it } from 'vitest'
import {
  WORKSPACE_ACTIVITY_ORDER,
  activeViewForWorkspaceActivity,
  getVisibleWorkspaceActivities
} from './workspace-activity-items'

/**
 * Who holds the Agents noun. Inverted in place, wave by wave, so the diff is the evidence.
 *
 * Wave A pinned the defect: the rail entry a person read as "Agents" resolved to a feed of RUNNING
 * panes, while durable actors nobody could reach sat in PersistedState.agents[].
 * Wave B released the noun: the feed took its own name, Activity.
 * Wave C gave the noun to the durable actor, as an opt-in "Agents" rail entry.
 * Wave D (2026-09-24, here) folds that entry into Workspace: the durable agents are the Workspace
 * roster, and no rail entry routes to the retired Agents page any more.
 */
describe('the Agents product noun', () => {
  it('is reached through Workspace, the rail entry that owns the roster', () => {
    expect(activeViewForWorkspaceActivity('agent-workspace')).toBe('conversations')
  })

  it('is not held by the runtime feed, which answers to its own name', () => {
    expect(activeViewForWorkspaceActivity('activity')).toBe('activity')
  })

  it('routes no rail entry to the retired Agents page', () => {
    // `toEqual([])` over the whole ordered set: an entry quietly routed back to the old page would
    // reopen a second directory beside the roster.
    const reachesRetiredPage = WORKSPACE_ACTIVITY_ORDER.filter(
      (activity) => activeViewForWorkspaceActivity(activity) === 'agents'
    )
    expect(reachesRetiredPage).toEqual([])
  })

  it('keeps the runtime feed on its own switch', () => {
    expect(getVisibleWorkspaceActivities({ experimentalActivity: true })).toContain('activity')
    expect(getVisibleWorkspaceActivities({ showAgentWorkspaceButton: false })).not.toContain(
      'agent-workspace'
    )
    expect(getVisibleWorkspaceActivities({ experimentalActivity: false })).toContain(
      'agent-workspace'
    )
  })

  it('pins the order the Owner chose: Workspace first, then as before', () => {
    expect([...WORKSPACE_ACTIVITY_ORDER]).toEqual([
      'agent-workspace',
      'workspace',
      'tasks',
      'automations',
      'activity',
      'artifacts',
      'skills',
      'mobile'
    ])
  })
})
