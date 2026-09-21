// @vitest-environment happy-dom

/*
 * What the renderer RE-DERIVES for every dormant rail row on a store write that concerns none of them.
 *
 * The sibling file `terminal-rail-presentation-residency.test.tsx` counts DOM nodes and live
 * subscribers. Neither can see this: zustand notifies by iterating its listener Set on every
 * `setState` (`store/store-listener-census.ts:11-12`), so a subscriber count tells you how many
 * selectors exist and nothing about the work they do when one of them fires.
 *
 * `useTabAgent` (`lib/use-tab-agent.ts:187-265`) holds 13 of the rail row's 24 subscriptions, and two
 * of them allocate per evaluation — `hasRemoteRuntimePty` (:257-264) builds a Set and spreads it,
 * `focusedPaneKey` (:221-224) mints a string through `makePaneKey`. This file puts a number on that.
 *
 * CHARACTERIZATION OF TODAY, not a target. Both slopes below are expected to be linear and non-zero
 * right now. When the snapshot-keyed projection lands
 * (docs/reference/presentation-derivation-projection.md) these invert in place: the slope goes to
 * zero and the assertions here become the proof it did.
 *
 * Counts, not timings. This host runs near 11% free RAM, where a wall-clock reading drifts further
 * than any effect this change could produce (docs/reference/resource-density-lab.md).
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type * as I18nModule from '@/i18n/i18n'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import TerminalRail, { type TerminalRailTabActions } from './TerminalRail'

const counters = vi.hoisted(() => ({ resolverCalls: 0, paneKeyAllocations: 0 }))

vi.mock('@/i18n/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof I18nModule>()),
  translate: (_key: string, fallback: string) => fallback
}))

// Why wrap rather than replace: the real precedence ladder must still run, or this would measure a
// stub's cost. Counting is the only change.
vi.mock('@/lib/tab-agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tab-agent')>()
  const counted = <T extends (...args: never[]) => unknown>(fn: T): T =>
    ((...args: Parameters<T>) => {
      counters.resolverCalls += 1
      return fn(...args)
    }) as unknown as T
  return {
    ...actual,
    resolveFocusedTabAgent: counted(actual.resolveFocusedTabAgent),
    resolveSiblingTabAgent: counted(actual.resolveSiblingTabAgent),
    resolveFocusedCompletedTabAgent: counted(actual.resolveFocusedCompletedTabAgent),
    resolveSiblingCompletedTabAgent: counted(actual.resolveSiblingCompletedTabAgent),
    resolveFocusedRetainedTabAgent: counted(actual.resolveFocusedRetainedTabAgent),
    resolveSiblingRetainedTabAgent: counted(actual.resolveSiblingRetainedTabAgent)
  }
})

// makePaneKey is the string allocation inside useTabAgent's `focusedPaneKey` selector.
vi.mock('../../../../shared/stable-pane-id', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../shared/stable-pane-id')>()
  return {
    ...actual,
    makePaneKey: (...args: Parameters<typeof actual.makePaneKey>) => {
      counters.paneKeyAllocations += 1
      return actual.makePaneKey(...args)
    }
  }
})

const SCALES = [1, 10, 50, 100] as const

/** Hex-padded so the id stays a valid UUID past nine rows, which a repeated-digit pattern does not. */
const uuidAt = (prefix: number, n: number): string =>
  `${n.toString(16).padStart(8, '0')}-0000-4000-8000-${prefix.toString(16).padStart(4, '0')}${n
    .toString(16)
    .padStart(8, '0')}`

const initialAppState = useAppStore.getInitialState()
let container: HTMLDivElement
let root: Root

type FanoutMeasurement = {
  rows: number
  /** Calls into the agent-identity resolvers caused by ONE unrelated store write. */
  resolverCalls: number
  /** Pane-key strings minted by that same single write. */
  paneKeyAllocations: number
}

/** One dormant row as restore leaves it: a layout naming its pane, and no PTY anywhere. */
function dormantTab(index: number): { tab: TerminalTab; layout: TerminalLayoutSnapshot } {
  const tabId = uuidAt(0xaaa, index)
  const leafId = uuidAt(0xbbb, index)
  return {
    tab: {
      id: tabId,
      ptyId: null,
      worktreeId: 'repo-1::C:/work/orca',
      title: 'orca',
      customTitle: null,
      color: null,
      sortOrder: index,
      createdAt: 1_700_000_000_000 + index
    },
    layout: { root: { type: 'leaf', leafId }, activeLeafId: leafId, expandedLeafId: null }
  }
}

function tabActions(): TerminalRailTabActions {
  // Production always passes these (TabGroupPanel), so a row without them would be cheaper than real.
  return {
    groupId: 'group-1',
    groupTabs: [],
    onActivate: vi.fn(),
    onClose: vi.fn(),
    onCloseOthers: vi.fn(),
    onCloseToRight: vi.fn(),
    onCloseToLeft: vi.fn()
  }
}

async function measureFanout(rows: number): Promise<FanoutMeasurement> {
  const seeds = Array.from({ length: rows }, (_, index) => dormantTab(index))
  const layoutsByTabId: Record<string, TerminalLayoutSnapshot> = {}
  for (const seed of seeds) {
    layoutsByTabId[seed.tab.id] = seed.layout
  }
  await act(async () => {
    useAppStore.setState({ terminalLayoutsByTabId: layoutsByTabId } as Partial<AppState>)
  })

  await act(async () => {
    root.render(
      <TerminalRail tabs={seeds.map((seed) => seed.tab)} activeTabId={null} tabActions={tabActions()} />
    )
  })

  // The rail must actually be holding every row, or a low count would mean "nothing mounted"
  // rather than "nothing re-derived" — the two are indistinguishable downstream.
  expect(container.querySelectorAll('[data-terminal-rail-row]').length).toBe(rows)

  // Everything above is mount cost. Only what happens after this line is attributable to the write.
  counters.resolverCalls = 0
  counters.paneKeyAllocations = 0

  // A write no rail row depends on: the side panel opening says nothing about any terminal.
  await act(async () => {
    useAppStore.setState({ rightSidebarOpen: true } as Partial<AppState>)
  })

  const measurement: FanoutMeasurement = {
    rows,
    resolverCalls: counters.resolverCalls,
    paneKeyAllocations: counters.paneKeyAllocations
  }

  await act(async () => {
    root.render(null)
  })
  return measurement
}

/** Per-row slope taken between the smallest and largest point. */
function perRow(points: readonly FanoutMeasurement[], read: (p: FanoutMeasurement) => number) {
  const first = points[0]
  const last = points.at(-1)!
  return (read(last) - read(first)) / (last.rows - first.rows)
}

describe('terminal rail derivation fan-out', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    useAppStore.setState(initialAppState, true)
    counters.resolverCalls = 0
    counters.paneKeyAllocations = 0
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    document.body.replaceChildren()
    useAppStore.setState(initialAppState, true)
  })

  it('positive control: the counters can move at all', async () => {
    // Why: every assertion below reads a count, and a mock that silently failed to bind would
    // report zero — which is also what a perfectly projected implementation reports. Without this,
    // the red and the green branches are the same observable.
    const point = await measureFanout(1)
    expect(point.resolverCalls).toBeGreaterThan(0)
    expect(point.paneKeyAllocations).toBeGreaterThan(0)
  })

  it('re-derives agent identity for every dormant row on an unrelated store write', async () => {
    const points: FanoutMeasurement[] = []
    for (const rows of SCALES) {
      points.push(await measureFanout(rows))
    }

    const resolversPerRow = perRow(points, (p) => p.resolverCalls)
    const allocationsPerRow = perRow(points, (p) => p.paneKeyAllocations)

    // TODAY: both are linear and non-zero — one store write anywhere re-runs every row's identity
    // ladder and mints every row's pane key. The projection makes both slopes zero.
    expect(resolversPerRow).toBeGreaterThan(0)
    expect(allocationsPerRow).toBeGreaterThan(0)

    // Predictive, not descriptive: the slope comes from the 1- and 100-row points and must land the
    // intermediate points exactly. A per-row cost that is not linear fails here.
    const resolverBase = points[0].resolverCalls - resolversPerRow
    const allocationBase = points[0].paneKeyAllocations - allocationsPerRow
    expect(points.map((p) => p.resolverCalls)).toEqual(
      points.map((p) => resolverBase + p.rows * resolversPerRow)
    )
    expect(points.map((p) => p.paneKeyAllocations)).toEqual(
      points.map((p) => allocationBase + p.rows * allocationsPerRow)
    )

    const report = { resolversPerRow, allocationsPerRow, points }
    if (process.env.RAIL_FANOUT_REPORT) {
      // Vitest swallows console.info, so a measurement that must be read goes to a named file.
      const { writeFileSync } = await import('node:fs')
      writeFileSync(process.env.RAIL_FANOUT_REPORT, JSON.stringify(report, null, 2))
    }
    expect(report.points).toHaveLength(SCALES.length)
  })
})
