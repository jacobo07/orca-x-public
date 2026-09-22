import { describe, expect, it } from 'vitest'
import {
  WORKSPACE_ACTIVITY_ORDER,
  activeViewForWorkspaceActivity,
  getVisibleWorkspaceActivities
} from './workspace-activity-items'

/**
 * CHARACTERIZATION — what the Agents noun reaches today, pinned before W-C3 moves it.
 *
 * Orca now owns a durable product actor (`src/shared/agent-types.ts`, PersistedState.agents[]),
 * and the rail entry a person reads as "Agents" does not reach it. It reaches
 * `ActivityPrototypePage`: a paneKey-keyed inbox of RUNNING agent panes, with unread counts, a
 * Bell icon and live terminal portals in its rows. Every row there dies with its pane.
 *
 * These assertions state today's behaviour, not the wanted one. Wave C inverts them IN PLACE —
 * the diff between the two versions of this file is the evidence that the noun moved, which a new
 * test written beside a deleted one would not be.
 *
 * Nothing here asserts that the runtime feed is wrong. It asserts what it IS, so that the rename
 * cannot quietly take its function with it.
 */
describe('the Agents product noun, before W-C3', () => {
  it('gives the Agents noun to the runtime activity feed, not to a durable actor surface', () => {
    // 'activity' is ActivityPrototypePage — AgentStatusEntry keyed by paneKey, not Agent by AgentId.
    expect(activeViewForWorkspaceActivity('agents')).toBe('activity')
  })

  it('has no rail entry at all that reaches a persistent-agent surface', () => {
    // The positive half of the same claim: it is not that the noun points somewhere odd, it is
    // that the destination does not exist yet. Wave C is what makes this list non-empty.
    const reachesPersistentAgents = WORKSPACE_ACTIVITY_ORDER.filter(
      (activity) => activeViewForWorkspaceActivity(activity) === ('agents' as string)
    )
    expect(reachesPersistentAgents).toEqual([])
  })

  it('keeps the runtime feed behind the experiment toggle, so no default profile sees the noun', () => {
    // Why this matters for the rename: nothing is being taken from a default user, because the
    // entry carrying the wrong noun was never on for them in the first place.
    expect(getVisibleWorkspaceActivities({})).not.toContain('agents')
    expect(getVisibleWorkspaceActivities({ experimentalActivity: true })).toContain('agents')
  })
})
