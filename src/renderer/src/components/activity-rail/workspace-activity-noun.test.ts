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
 * while PersistedState.agents[] held durable actors that nobody could reach.
 *
 * Wave B (here) released the noun without yet giving it away: the feed is now called `activity`,
 * which is what it always was internally. Nothing carries the Agents noun for one commit, on
 * purpose — the old surface must be proven intact under its true name before a new surface takes
 * the name it was using.
 *
 * Wave C gives the noun to the durable actor and turns the second assertion around.
 */
describe('the Agents product noun', () => {
  it('no longer lets the runtime feed hold the Agents noun', () => {
    // The rail id and the view id finally agree, and both say what the surface is.
    expect(activeViewForWorkspaceActivity('activity')).toBe('activity')
    expect([...WORKSPACE_ACTIVITY_ORDER]).not.toContain('agents')
  })

  it('has no rail entry yet that reaches a persistent-agent surface', () => {
    // Still empty after wave B, and that is the point: the noun is unowned rather than
    // misattributed. Wave C is what makes this list non-empty and inverts the assertion.
    const reachesPersistentAgents = WORKSPACE_ACTIVITY_ORDER.filter(
      (activity) => activeViewForWorkspaceActivity(activity) === ('agents' as string)
    )
    expect(reachesPersistentAgents).toEqual([])
  })

  it('keeps the runtime feed behind the same experiment toggle the rename did not touch', () => {
    // Why this matters: the rename takes nothing from anyone, because the entry carrying the wrong
    // noun was opt-in and off by default. The setting key is deliberately unchanged — renaming a
    // persisted GlobalSettings key WOULD have needed a migration, and the rail id did not.
    expect(getVisibleWorkspaceActivities({})).not.toContain('activity')
    expect(getVisibleWorkspaceActivities({ experimentalActivity: true })).toContain('activity')
  })

  it('still routes the renamed entry to the page it always rendered', () => {
    // The preservation half of the rename. A persisted `activeView: 'activity'` from any older
    // profile resolves to exactly the same TopLevelView, so no navigation state was orphaned and
    // no migration was needed — the function was never attached to the rail id.
    expect(activeViewForWorkspaceActivity('activity')).toBe('activity')
  })
})
