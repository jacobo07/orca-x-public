// @vitest-environment happy-dom

/*
 * What the renderer RE-DERIVES for every dormant rail row on a store write that concerns none of them.
 *
 * The sibling file `terminal-rail-presentation-residency.test.tsx` counts DOM nodes and live
 * subscribers. Neither can see this: zustand notifies by iterating its listener Set on every
 * `setState` (`store/store-listener-census.ts:11-12`), so a subscriber count tells you how many
 * selectors exist and nothing about the work they do when one of them fires.
 *
 * `useTabAgent` USED TO hold 13 of the rail row's 24 subscriptions, two of which allocated on every
 * evaluation: one built a Set and spread it, another minted a string through `makePaneKey`. This
 * file put the number on that, and now holds the line at zero.
 *
 * INVERTED IN PLACE. Until `lib/tab-agent-projection.ts` landed, both slopes below were linear and
 * non-zero: 6 resolver calls and 4 pane-key strings per row, per write, exactly linear with a zero
 * intercept — 600 and 400 respectively at 100 rows, for a write about the side panel. The same
 * assertions now demand zero, so this file is the proof the projection works rather than a second
 * test written beside a deleted one (docs/reference/presentation-derivation-projection.md).
 *
 * The control below is what keeps that zero honest. A mock that silently failed to bind reports
 * zero too, and a projection that quietly stopped deriving anything at all would report zero on
 * BOTH writes. So a write that genuinely moves the projection's inputs must still cost the full
 * per-row derivation, and that is asserted, at the same scales, in the same run.
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
import type * as TabAgentModule from '@/lib/tab-agent'
import type * as StablePaneIdModule from '../../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import TerminalRail, { type TerminalRailTabActions } from './TerminalRail'

const counters = vi.hoisted(() => ({ resolverCalls: 0, paneKeyAllocations: 0 }))

vi.mock('@/i18n/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof I18nModule>()),
  translate: (_key: string, fallback: string) => fallback
}))

// Why wrap rather than replace: the real precedence ladder must still run, or this would measure a
// stub's cost. Counting is the only change. The resolvers moved from the hook into the projection,
// so mocking the module still intercepts them wherever they are called from.
vi.mock('@/lib/tab-agent', async (importOriginal) => {
  const actual = await importOriginal<typeof TabAgentModule>()
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

// makePaneKey is the string allocation behind the focused pane key.
vi.mock('../../../../shared/stable-pane-id', async (importOriginal) => {
  const actual = await importOriginal<typeof StablePaneIdModule>()
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

type StoreWrite = () => void

/** A write no rail row depends on: the side panel opening says nothing about any terminal. */
const unrelatedWrite: StoreWrite = () => {
  useAppStore.setState({ rightSidebarOpen: true } as Partial<AppState>)
}

/**
 * A new reference for a slice the projection reads. Content-equal on purpose: the derivation must
 * re-run, so the counters move, while structural sharing still spares every row a re-render.
 */
const projectionInputWrite: StoreWrite = () => {
  useAppStore.setState({ agentStatusByPaneKey: {} } as Partial<AppState>)
}

async function measureFanout(rows: number, write: StoreWrite): Promise<FanoutMeasurement> {
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
      <TerminalRail
        tabs={seeds.map((seed) => seed.tab)}
        activeTabId={null}
        tabActions={tabActions()}
      />
    )
  })

  // The rail must actually be holding every row, or a low count would mean "nothing mounted"
  // rather than "nothing re-derived" — the two are indistinguishable downstream.
  expect(container.querySelectorAll('[data-terminal-rail-row]').length).toBe(rows)

  // Everything above is mount cost. Only what happens after this line is attributable to the write.
  counters.resolverCalls = 0
  counters.paneKeyAllocations = 0

  await act(async () => {
    write()
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

  it('control: a write the projection DOES depend on still derives every row', async () => {
    // Load-bearing. The assertion that matters in this file is a zero, and three different worlds
    // produce a zero: the projection working, a mock that failed to bind, and a projection that
    // stopped deriving anything at all. Only this case tells them apart, so it runs at the same
    // scales, in the same run, against the same counters.
    const points = [
      await measureFanout(1, projectionInputWrite),
      await measureFanout(50, projectionInputWrite)
    ]

    expect(points[0].resolverCalls).toBeGreaterThan(0)
    expect(points[0].paneKeyAllocations).toBeGreaterThan(0)

    // Still linear, and that is correct: when the inputs genuinely move, every row's identity is
    // genuinely stale. The projection removes repeated derivation, never necessary derivation.
    const resolversPerRow = perRow(points, (p) => p.resolverCalls)
    const allocationsPerRow = perRow(points, (p) => p.paneKeyAllocations)
    expect(resolversPerRow).toBeGreaterThan(0)
    expect(allocationsPerRow).toBeGreaterThan(0)

    if (process.env.RAIL_FANOUT_CONTROL_REPORT) {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(
        process.env.RAIL_FANOUT_CONTROL_REPORT,
        JSON.stringify({ resolversPerRow, allocationsPerRow, points }, null, 2)
      )
    }
  })

  it('derives nothing for any row on a store write it does not depend on', async () => {
    const points: FanoutMeasurement[] = []
    for (const rows of SCALES) {
      points.push(await measureFanout(rows, unrelatedWrite))
    }

    const resolversPerRow = perRow(points, (p) => p.resolverCalls)
    const allocationsPerRow = perRow(points, (p) => p.paneKeyAllocations)

    // Was 6 and 4 before lib/tab-agent-projection.ts. A write about the side panel now costs a
    // reference comparison per row and nothing else — no identity ladder, no pane-key string.
    expect(resolversPerRow).toBe(0)
    expect(allocationsPerRow).toBe(0)

    // Not just a zero slope: zero at every point, so a constant per-write cost cannot hide in the
    // intercept the way a slope-only assertion would let it.
    expect(points.map((p) => p.resolverCalls)).toEqual(SCALES.map(() => 0))
    expect(points.map((p) => p.paneKeyAllocations)).toEqual(SCALES.map(() => 0))

    const report = { resolversPerRow, allocationsPerRow, points }
    if (process.env.RAIL_FANOUT_REPORT) {
      // Vitest swallows console.info, so a measurement that must be read goes to a named file.
      const { writeFileSync } = await import('node:fs')
      writeFileSync(process.env.RAIL_FANOUT_REPORT, JSON.stringify(report, null, 2))
    }
    expect(report.points).toHaveLength(SCALES.length)
  })
})
