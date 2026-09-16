import { describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import {
  COLD_ACTIVATION_TAB_DEFER_THRESHOLD,
  decideTerminalTabMount,
  planColdActivationTabDeferral,
  revealActivationDeferredTabs
} from './background-terminal-worktree-mount'

/**
 * What activating a worktree does to panes whose processes are gone.
 *
 * W1 (2377bd18b) pinned the old contract here: deferral is a render-cost optimization that only
 * withholds tabs a parked byte watcher can cover, a tab with no PTY is never coverable, so every
 * slept row mounted — and a mount is `connectPanePty`, i.e. cold restore and resume.
 *
 * W6 inverted those two cases rather than replacing them. A positively dormant tab is held back
 * by `decideTerminalTabMount` whatever the restriction says, while an unmarked tab with no PTY
 * (a brand-new or failed terminal) still mounts. The deferral controls below are unchanged.
 */

type PlanArgs = Parameters<typeof planColdActivationTabDeferral>[0]
type Row = Pick<TerminalTab, 'id' | 'dormancy' | 'dormantOpenRequested'>

const WORKTREE = 'repo-1::/w/one'
const DORMANT = { reason: 'working-set-restore' } as const

function makeTabIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `tab-${index}`)
}

function rows(tabIds: string[], dormant: (tabId: string) => boolean): Row[] {
  return tabIds.map((id) => (dormant(id) ? { id, dormancy: DORMANT } : { id }))
}

function mountedOf(restrictions: PlanArgs['restrictions'], tabs: Row[]): string[] {
  const restricted = restrictions.get(WORKTREE) ?? null
  return tabs.filter((tab) => decideTerminalTabMount(restricted, tab) === 'mount').map((t) => t.id)
}

function runPlan(overrides: {
  tabs: Row[]
  isTabDeferrable: (tabId: string) => boolean
  immediateTabIds?: ReadonlySet<string>
}): {
  deferred: boolean
  mounted: string[]
  unmounted: string[]
  restrictions: PlanArgs['restrictions']
  deferredMountTabIdsByWorktree: PlanArgs['deferredMountTabIdsByWorktree']
} {
  const restrictions: PlanArgs['restrictions'] = new Map()
  const deferredMountTabIdsByWorktree: PlanArgs['deferredMountTabIdsByWorktree'] = new Map()
  const allTabIds = overrides.tabs.map((tab) => tab.id)
  const deferred = planColdActivationTabDeferral({
    restrictions,
    deferredMountTabIdsByWorktree,
    worktreeId: WORKTREE,
    allTabIds,
    isTabLive: () => false,
    isTabDeferrable: overrides.isTabDeferrable,
    immediateTabIds: overrides.immediateTabIds ?? new Set()
  })
  // The mount decision the render pass actually makes, not the planner's boolean.
  const mounted = mountedOf(restrictions, overrides.tabs)
  return {
    deferred,
    mounted,
    unmounted: allTabIds.filter((tabId) => !mounted.includes(tabId)),
    restrictions,
    deferredMountTabIdsByWorktree
  }
}

describe('cold activation and panes with no live process', () => {
  it('mounts no dormant tab, however many there are', () => {
    const allTabIds = makeTabIds(12)
    const result = runPlan({ tabs: rows(allTabIds, () => true), isTabDeferrable: () => false })

    expect(result.deferred).toBe(false)
    expect(result.mounted).toEqual([])
    expect(result.unmounted).toEqual(allTabIds)
  })

  it('leaves the one dormant tab hidden among deferrable siblings unmounted', () => {
    const allTabIds = makeTabIds(12)
    const dormant = 'tab-7'
    const result = runPlan({
      tabs: rows(allTabIds, (id) => id === dormant),
      isTabDeferrable: (tabId) => tabId !== dormant,
      immediateTabIds: new Set(['tab-0'])
    })

    expect(result.deferred).toBe(true)
    expect(result.mounted).toEqual(['tab-0'])
    expect(result.unmounted).toContain(dormant)
  })

  it('keeps dormant tabs unmounted below the threshold, where nothing is deferred', () => {
    const allTabIds = makeTabIds(3)
    const result = runPlan({
      tabs: rows(allTabIds, () => true),
      isTabDeferrable: () => false,
      immediateTabIds: new Set(['tab-0'])
    })

    expect(result.deferred).toBe(false)
    expect(result.restrictions.has(WORKTREE)).toBe(false)
    expect(result.mounted).toEqual([])
  })

  it('does not wake the selected tab just because it is selected', () => {
    const allTabIds = makeTabIds(3)
    const result = runPlan({
      tabs: rows(allTabIds, () => true),
      isTabDeferrable: () => false,
      immediateTabIds: new Set(['tab-1'])
    })

    expect(result.mounted).not.toContain('tab-1')
  })

  it('keeps dormant tabs unmounted after a reveal dissolves the restriction', () => {
    const allTabIds = makeTabIds(12)
    const tabs = rows(allTabIds, (id) => id === 'tab-7')
    const result = runPlan({
      tabs,
      isTabDeferrable: (id) => id !== 'tab-7',
      immediateTabIds: new Set(['tab-0'])
    })
    revealActivationDeferredTabs({
      restrictions: result.restrictions,
      deferredMountTabIdsByWorktree: result.deferredMountTabIdsByWorktree,
      worktreeId: WORKTREE,
      allTabIds,
      immediateTabIds: new Set(allTabIds)
    })

    expect(result.restrictions.has(WORKTREE)).toBe(false)
    expect(mountedOf(result.restrictions, tabs)).toEqual(allTabIds.filter((id) => id !== 'tab-7'))
  })

  it('mounts a tab with no PTY that carries no dormancy marker (new or failed terminal)', () => {
    const allTabIds = makeTabIds(3)
    const result = runPlan({
      tabs: rows(allTabIds, (id) => id !== 'tab-2'),
      isTabDeferrable: () => false
    })

    expect(result.mounted).toEqual(['tab-2'])
  })

  it('mounts exactly the one dormant tab someone asked to open', () => {
    const allTabIds = makeTabIds(6)
    const tabs: Row[] = allTabIds.map((id) =>
      id === 'tab-3'
        ? { id, dormancy: DORMANT, dormantOpenRequested: true }
        : { id, dormancy: DORMANT }
    )
    const result = runPlan({ tabs, isTabDeferrable: () => false })

    expect(result.mounted).toEqual(['tab-3'])
  })

  it('names why a tab is not mounted', () => {
    const restricted = new Set(['tab-0'])
    expect(decideTerminalTabMount(restricted, { id: 'tab-1' })).toBe('render-deferred')
    expect(decideTerminalTabMount(restricted, { id: 'tab-0', dormancy: DORMANT })).toBe('dormant')
    expect(decideTerminalTabMount(null, { id: 'tab-2' })).toBe('mount')
  })
})

describe('cold activation deferral (positive control)', () => {
  it('withholds coverable tabs once past the threshold', () => {
    const allTabIds = makeTabIds(12)
    const result = runPlan({
      tabs: rows(allTabIds, () => false),
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
      tabs: rows(makeTabIds(COLD_ACTIVATION_TAB_DEFER_THRESHOLD + 1), () => false),
      isTabDeferrable: () => true,
      immediateTabIds
    })
    const pastThreshold = runPlan({
      tabs: rows(makeTabIds(COLD_ACTIVATION_TAB_DEFER_THRESHOLD + 2), () => false),
      isTabDeferrable: () => true,
      immediateTabIds
    })

    expect(atThreshold.deferred).toBe(false)
    expect(atThreshold.unmounted).toEqual([])
    expect(pastThreshold.deferred).toBe(true)
    expect(pastThreshold.unmounted).toHaveLength(COLD_ACTIVATION_TAB_DEFER_THRESHOLD + 1)
  })
})
