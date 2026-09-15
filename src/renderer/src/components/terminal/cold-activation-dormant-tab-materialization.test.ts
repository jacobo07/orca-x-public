import { describe, expect, it } from 'vitest'
import {
  COLD_ACTIVATION_TAB_DEFER_THRESHOLD,
  planColdActivationTabDeferral,
  shouldMountBackgroundWorktreeTab
} from './background-terminal-worktree-mount'

/**
 * Characterization: what activating a worktree does to panes whose processes are gone.
 *
 * Deferral is a render-cost optimization, not a residency policy. It keeps a tab
 * unmounted only while parked byte watchers can own its bells/titles/completions,
 * and `canWatcherCoverParkedTerminalTab` requires a live park-restorable PTY. A
 * slept pane has none, so it is NOT deferrable and mounts on activation — and a
 * mount is `connectPanePty`, i.e. cold restore and provider-session resume.
 *
 * So today "the row is in the rail" and "the process is running" are the same
 * state for a slept pane once its workspace is opened. These cases assert that
 * as the current contract so the working-set change is visible as a diff rather
 * than as a claim. The second block is the positive control: deferral does fire
 * for tabs watchers can cover, so the first block is not vacuous.
 */

type PlanArgs = Parameters<typeof planColdActivationTabDeferral>[0]

const WORKTREE = 'repo-1::/w/one'

function makeTabIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `tab-${index}`)
}

function runPlan(overrides: {
  allTabIds: string[]
  isTabDeferrable: (tabId: string) => boolean
  immediateTabIds?: ReadonlySet<string>
}): {
  deferred: boolean
  mounted: string[]
  unmounted: string[]
} {
  const restrictions: PlanArgs['restrictions'] = new Map()
  const deferredMountTabIdsByWorktree: PlanArgs['deferredMountTabIdsByWorktree'] = new Map()
  const deferred = planColdActivationTabDeferral({
    restrictions,
    deferredMountTabIdsByWorktree,
    worktreeId: WORKTREE,
    allTabIds: overrides.allTabIds,
    isTabLive: () => false,
    isTabDeferrable: overrides.isTabDeferrable,
    immediateTabIds: overrides.immediateTabIds ?? new Set()
  })
  // The mount decision the render pass actually makes, not the planner's boolean.
  const restricted = restrictions.get(WORKTREE) ?? null
  const mounted = overrides.allTabIds.filter((tabId) =>
    shouldMountBackgroundWorktreeTab(restricted, tabId)
  )
  return {
    deferred,
    mounted,
    unmounted: overrides.allTabIds.filter((tabId) => !mounted.includes(tabId))
  }
}

describe('cold activation and panes with no live process', () => {
  it('mounts every dormant tab, however many there are', () => {
    const allTabIds = makeTabIds(12)
    const result = runPlan({ allTabIds, isTabDeferrable: () => false })

    expect(result.deferred).toBe(false)
    expect(result.mounted).toEqual(allTabIds)
    expect(result.unmounted).toEqual([])
  })

  it('mounts the one dormant tab hidden among deferrable siblings', () => {
    const allTabIds = makeTabIds(12)
    const dormant = 'tab-7'
    const result = runPlan({
      allTabIds,
      isTabDeferrable: (tabId) => tabId !== dormant,
      immediateTabIds: new Set(['tab-0'])
    })

    expect(result.deferred).toBe(true)
    expect(result.mounted).toContain(dormant)
    expect(result.unmounted).not.toContain(dormant)
  })
})

describe('cold activation deferral (positive control)', () => {
  it('withholds coverable tabs once past the threshold', () => {
    const allTabIds = makeTabIds(12)
    const result = runPlan({
      allTabIds,
      isTabDeferrable: () => true,
      immediateTabIds: new Set(['tab-0'])
    })

    expect(result.deferred).toBe(true)
    expect(result.mounted).toEqual(['tab-0'])
    expect(result.unmounted).toHaveLength(allTabIds.length - 1)
  })

  it('mounts everything at the threshold and defers one tab past it', () => {
    const immediateTabIds = new Set(['tab-0'])
    const atThreshold = runPlan({
      allTabIds: makeTabIds(COLD_ACTIVATION_TAB_DEFER_THRESHOLD + 1),
      isTabDeferrable: () => true,
      immediateTabIds
    })
    const pastThreshold = runPlan({
      allTabIds: makeTabIds(COLD_ACTIVATION_TAB_DEFER_THRESHOLD + 2),
      isTabDeferrable: () => true,
      immediateTabIds
    })

    expect(atThreshold.deferred).toBe(false)
    expect(atThreshold.unmounted).toEqual([])
    expect(pastThreshold.deferred).toBe(true)
    expect(pastThreshold.unmounted).toHaveLength(COLD_ACTIVATION_TAB_DEFER_THRESHOLD + 1)
  })
})
