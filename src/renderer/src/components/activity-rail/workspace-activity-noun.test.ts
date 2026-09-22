import { describe, expect, it } from 'vitest'
import {
  WORKSPACE_ACTIVITY_ORDER,
  activeViewForWorkspaceActivity,
  getVisibleWorkspaceActivities
} from './workspace-activity-items'

/**
 * Who holds the Agents noun. Inverted in place, wave by wave, so the diff is the evidence.
 *
 * Wave A pinned the defect: the rail entry a person read as "Agents" resolved to
 * ActivityPrototypePage — a paneKey-keyed inbox of RUNNING panes, whose rows die with their pane —
 * while PersistedState.agents[] held durable actors nobody could reach.
 *
 * Wave B released the noun without giving it away: the feed took the name it always had internally,
 * and for one commit nothing carried the Agents noun at all — so the old surface could be proven
 * intact under its true name before a new one took the name it had been using.
 *
 * Wave C (here) gives the noun to the durable actor.
 */
describe('the Agents product noun', () => {
  it('belongs to the persistent-agent surface', () => {
    expect(activeViewForWorkspaceActivity('agents')).toBe('agents')
  })

  it('is no longer held by the runtime feed, which answers to its own name', () => {
    expect(activeViewForWorkspaceActivity('activity')).toBe('activity')
  })

  it('reaches exactly one surface, so the noun cannot be ambiguous again', () => {
    // The assertion that was empty through waves A and B, turned around. `toEqual` and not
    // `toContain`: two entries resolving to the persistent-agent view would be the same defect
    // this wave exists to fix, wearing the opposite sign.
    const reachesPersistentAgents = WORKSPACE_ACTIVITY_ORDER.filter(
      (activity) => activeViewForWorkspaceActivity(activity) === 'agents'
    )
    expect(reachesPersistentAgents).toEqual(['agents'])
  })

  it('still routes the renamed entry to the page it always rendered', () => {
    // The preservation half. A persisted `activeView: 'activity'` from any older profile resolves
    // to exactly the same TopLevelView it always did, so no navigation state was orphaned and no
    // migration was needed — the function was never attached to the rail id.
    expect(activeViewForWorkspaceActivity('activity')).toBe('activity')
  })

  it('keeps the two surfaces on separate switches', () => {
    // They shared a noun and never shared a meaning. One flag for both would mean turning the
    // runtime feed off silently took the durable roster with it.
    expect(getVisibleWorkspaceActivities({ experimentalActivity: true })).not.toContain('agents')
    expect(getVisibleWorkspaceActivities({ showAgentsButton: true })).not.toContain('activity')
  })

  it('shows Agents only on an explicit opt-in, because an unset key is not consent', () => {
    expect(getVisibleWorkspaceActivities({})).not.toContain('agents')
    expect(getVisibleWorkspaceActivities(null)).not.toContain('agents')
    expect(getVisibleWorkspaceActivities({ showAgentsButton: false })).not.toContain('agents')
    expect(getVisibleWorkspaceActivities({ showAgentsButton: true })).toContain('agents')
  })

  it('places Agents next to the chats rather than reordering the rail', () => {
    // The one ordering claim W-C3 makes: a chat is with nobody in particular, an agent is somebody
    // you keep, and the durable half belongs beside the transient one. Everything else is pinned
    // to where it already was, so a future IA wave can move the rest deliberately.
    expect([...WORKSPACE_ACTIVITY_ORDER]).toEqual([
      'workspace',
      'conversations',
      'agents',
      'tasks',
      'automations',
      'activity',
      'artifacts',
      'skills',
      'mobile'
    ])
  })
})
