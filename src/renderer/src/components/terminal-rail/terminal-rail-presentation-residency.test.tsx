// @vitest-environment happy-dom

/*
 * What the renderer spends REPRESENTING a row that renders no terminal.
 *
 * The byte curve (docs/reference/resource-density-lab.md) put the Dormant Session Tax at ~1 MB per
 * remembered row and located 68-79% of it in the renderer, while the row's own store state is about
 * 1.1 KB. That gap is presentation residency, and this file measures its load-independent half:
 * DOM nodes and live store subscriptions per dormant rail row.
 *
 * Counts, not bytes, on purpose. The lab's rule is that a count is load-independent and a byte
 * figure on this host is not; the byte half runs in the real app where a working set can be read.
 *
 * Altitude: this is the RAIL's cost for a dormant row, not the whole renderer's. The tab strip
 * renders the same tabs and is measured nowhere here.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { readStoreListenerCount } from '@/store/store-listener-census'
import type { AppState } from '@/store/types'
import type * as I18nModule from '@/i18n/i18n'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import TerminalRail, { type TerminalRailTabActions } from './TerminalRail'

vi.mock('@/i18n/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof I18nModule>()),
  translate: (_key: string, fallback: string) => fallback
}))

/**
 * Scales the byte curve already ran, so the two halves describe the same population. 100 is left
 * out because the byte curve could not afford it, not because the rail cannot hold it.
 */
const SCALES = [1, 10, 50] as const

/** Hex-padded so the id stays a valid UUID past nine rows, which a repeated-digit pattern does not. */
const uuidAt = (prefix: number, n: number): string =>
  `${n.toString(16).padStart(8, '0')}-0000-4000-8000-${prefix.toString(16).padStart(4, '0')}${n
    .toString(16)
    .padStart(8, '0')}`

const initialAppState = useAppStore.getInitialState()
let container: HTMLDivElement
let root: Root

type RailMeasurement = {
  rows: number
  /** Elements in the rail's subtree. */
  domNodes: number
  /** Rows the rail actually rendered. Equal to `rows` means nothing was virtualized away. */
  rowsInDom: number
  /** Live zustand subscribers held while the rail is mounted, above the unmounted baseline. */
  listeners: number
  /** Preview cards connected to a terminal. A row nobody hovers must connect nothing. */
  openPreviews: number
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
      // One shared title, so nothing can resolve a row by name.
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

async function measureRail(rows: number): Promise<RailMeasurement> {
  const seeds = Array.from({ length: rows }, (_, index) => dormantTab(index))
  const layoutsByTabId: Record<string, TerminalLayoutSnapshot> = {}
  for (const seed of seeds) {
    layoutsByTabId[seed.tab.id] = seed.layout
  }
  await act(async () => {
    useAppStore.setState({ terminalLayoutsByTabId: layoutsByTabId } as Partial<AppState>)
  })

  const baseline = readStoreListenerCount()
  expect(baseline).not.toBeNull()

  await act(async () => {
    root.render(
      <TerminalRail
        tabs={seeds.map((seed) => seed.tab)}
        activeTabId={null}
        tabActions={tabActions()}
      />
    )
  })

  const mounted = readStoreListenerCount()
  expect(mounted).not.toBeNull()

  const measurement: RailMeasurement = {
    rows,
    domNodes: container.querySelectorAll('*').length,
    rowsInDom: container.querySelectorAll('[data-terminal-rail-row]').length,
    listeners: mounted! - baseline!,
    openPreviews: container.querySelectorAll('[data-terminal-preview-card]').length
  }

  await act(async () => {
    root.render(null)
  })
  // A rail that never released its subscribers would make every later reading cumulative.
  expect(readStoreListenerCount()).toBe(baseline)
  return measurement
}

/** Per-row slope taken between the smallest and largest point, which must be a whole number. */
function perRow(points: readonly RailMeasurement[], read: (point: RailMeasurement) => number) {
  const first = points[0]
  const last = points.at(-1)!
  return (read(last) - read(first)) / (last.rows - first.rows)
}

describe('terminal rail presentation residency', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    useAppStore.setState(initialAppState, true)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    document.body.replaceChildren()
    useAppStore.setState(initialAppState, true)
  })

  it('renders every dormant row, at every scale', async () => {
    const points: RailMeasurement[] = []
    for (const rows of SCALES) {
      points.push(await measureRail(rows))
    }

    // Characterization of TODAY: the rail maps over all rows into an overflow-y-auto div, so a row
    // scrolled far out of view is still a mounted subtree. The estate ships @tanstack/react-virtual
    // and uses it in three other lists; this one does not. When that changes, invert this in place.
    expect(points.map((point) => point.rowsInDom)).toEqual([...SCALES])

    // Nobody hovered, so no preview may be connected — the per-row figures below exclude previews.
    expect(points.map((point) => point.openPreviews)).toEqual(SCALES.map(() => 0))
  })

  it('costs a fixed number of DOM nodes and store subscribers per dormant row', async () => {
    const points: RailMeasurement[] = []
    for (const rows of SCALES) {
      points.push(await measureRail(rows))
    }

    const domPerRow = perRow(points, (point) => point.domNodes)
    const listenersPerRow = perRow(points, (point) => point.listeners)
    expect(Number.isInteger(domPerRow)).toBe(true)
    expect(Number.isInteger(listenersPerRow)).toBe(true)

    // Predictive, not descriptive: the slope comes from the 1- and 50-row points and must land the
    // 10-row point exactly. A sublinear rail (virtualized, pooled, or windowed) fails here.
    const domBase = points[0].domNodes - domPerRow
    const listenerBase = points[0].listeners - listenersPerRow
    expect(points.map((point) => point.domNodes)).toEqual(
      points.map((point) => domBase + point.rows * domPerRow)
    )
    expect(points.map((point) => point.listeners)).toEqual(
      points.map((point) => listenerBase + point.rows * listenersPerRow)
    )

    // Ratchet. Was 24 until `lib/tab-agent-projection.ts` collapsed useTabAgent's thirteen
    // subscriptions to two — one snapshot-keyed projection and one stable action reference. Growth
    // is a decision to make in a diff; a shrink must LOWER these numbers, so the next growth cannot
    // hide inside the slack a shrink would otherwise leave behind.
    //
    // A count is not a cost: what each subscriber does on a store write is measured separately, in
    // `terminal-rail-derivation-fanout.test.tsx`. Lowering this number while moving the same work
    // into a more expensive selector would pass here and fail there.
    expect({ domPerRow, listenersPerRow }).toEqual({ domPerRow: 9, listenersPerRow: 13 })

    const report = { domPerRow, listenersPerRow, points }
    if (process.env.RAIL_RESIDENCY_REPORT) {
      // Vitest swallows console.info, so a measurement that must be read goes to a named file.
      const { writeFileSync } = await import('node:fs')
      writeFileSync(process.env.RAIL_RESIDENCY_REPORT, JSON.stringify(report, null, 2))
    }
    expect(report.points).toHaveLength(SCALES.length)
  })
})
