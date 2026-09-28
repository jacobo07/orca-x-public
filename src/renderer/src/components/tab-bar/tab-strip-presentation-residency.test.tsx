// @vitest-environment happy-dom

/*
 * What the renderer spends REPRESENTING a dormant tab in the TAB STRIP.
 *
 * The rail's half of this question is measured in
 * `components/terminal-rail/terminal-rail-presentation-residency.test.tsx`, whose own docstring
 * names the hole this file fills: "the tab strip renders the same tabs and is measured nowhere
 * here."
 *
 * CORRECTION, measured in the real app after this file first landed
 * (`tests/e2e/dormant-presentation-attribution.spec.ts`): THE TWO SLOPES MUST NOT BE ADDED. The
 * rail and the strip are mutually exclusive and they swap — with the rail expanded the strip
 * renders 0 terminal tabs, and collapsing the rail moves all of them into the strip. A dormant row
 * therefore mounts ONE presentation subtree, never two, and `terminalRailCollapsed` only chooses
 * which. The first version of this comment claimed a combined per-row cost; that was inferred from
 * this fixture being *able* to mount N SortableTabs, which says nothing about what production
 * mounts alongside what.
 *
 * So the number here is the cost of the strip WHEN THE STRIP IS THE MOUNTED SURFACE, and the right
 * comparison against the rail file is a choice between the two, not a sum. Deliberately the same
 * instrument, population and scales, so that comparison is like for like. Counts, not bytes: a
 * count is load-independent and a byte figure on this host is not
 * (docs/reference/resource-density-lab.md).
 *
 * Altitude: this is the STRIP's cost for a dormant tab. It is not the whole renderer's, and a
 * subscriber count is not a byte figure — 9 DOM nodes cannot be a megabyte and also cannot prove
 * that a megabyte is absent.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DndContext } from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { readStoreListenerCount } from '@/store/store-listener-census'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AppState } from '@/store/types'
import type * as I18nModule from '@/i18n/i18n'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import type { TabDragItemData } from '../tab-group/tab-drag-data'
import SortableTab from './SortableTab'

vi.mock('@/i18n/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof I18nModule>()),
  translate: (_key: string, fallback: string) => fallback
}))

/** Same scales as the rail file, so the two per-row slopes describe one population. */
const SCALES = [1, 10, 50] as const

/** Hex-padded so the id stays a valid UUID past nine tabs, which a repeated-digit pattern does not. */
const uuidAt = (prefix: number, n: number): string =>
  `${n.toString(16).padStart(8, '0')}-0000-4000-8000-${prefix.toString(16).padStart(4, '0')}${n
    .toString(16)
    .padStart(8, '0')}`

const initialAppState = useAppStore.getInitialState()
let container: HTMLDivElement
let root: Root

type StripMeasurement = {
  tabs: number
  domNodes: number
  /** Tabs the strip actually rendered. Equal to `tabs` means nothing was virtualized away. */
  tabsInDom: number
  listeners: number
}

/** The rail file's dormant row, field for field, so both instruments measure one population. */
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

function dragData(tab: TerminalTab): TabDragItemData {
  return {
    kind: 'tab',
    worktreeId: tab.worktreeId,
    groupId: 'group-1',
    unifiedTabId: tab.id,
    visibleTabId: tab.id,
    tabType: 'terminal',
    label: tab.title,
    color: null
  }
}

async function measureStrip(tabs: number): Promise<StripMeasurement> {
  const seeds = Array.from({ length: tabs }, (_, index) => dormantTab(index))
  const layoutsByTabId: Record<string, TerminalLayoutSnapshot> = {}
  for (const seed of seeds) {
    layoutsByTabId[seed.tab.id] = seed.layout
  }
  await act(async () => {
    useAppStore.setState({ terminalLayoutsByTabId: layoutsByTabId } as Partial<AppState>)
  })

  const baseline = readStoreListenerCount()
  expect(baseline).not.toBeNull()

  const noop = vi.fn()
  await act(async () => {
    root.render(
      // Production shape: the strip's items live inside a SortableContext (tab-bar-surface.tsx),
      // itself inside the workspace DndContext. Mounting them bare would undercount every
      // registration dnd-kit makes per sortable item.
      <TooltipProvider>
        <DndContext>
          <SortableContext items={seeds.map((seed) => seed.tab.id)}>
            {seeds.map((seed, index) => (
              <SortableTab
                key={seed.tab.id}
                tab={seed.tab}
                unifiedTabId={seed.tab.id}
                groupId="group-1"
                tabCount={seeds.length}
                hasTabsToRight={index < seeds.length - 1}
                hasTabsToLeft={index > 0}
                isActive={false}
                isPinned={false}
                isExpanded={false}
                onActivate={noop}
                onClose={noop}
                onCloseOthers={noop}
                onCloseToRight={noop}
                onCloseToLeft={noop}
                onSetCustomTitle={noop}
                onSetTabColor={noop}
                onTogglePin={noop}
                onToggleExpand={noop}
                dragData={dragData(seed.tab)}
              />
            ))}
          </SortableContext>
        </DndContext>
      </TooltipProvider>
    )
  })

  const mounted = readStoreListenerCount()
  expect(mounted).not.toBeNull()

  const measurement: StripMeasurement = {
    tabs,
    domNodes: container.querySelectorAll('*').length,
    tabsInDom: container.querySelectorAll('[data-tab-id]').length,
    listeners: mounted! - baseline!
  }

  await act(async () => {
    root.render(null)
  })
  // A strip that never released its subscribers would make every later reading cumulative.
  expect(readStoreListenerCount()).toBe(baseline)
  return measurement
}

/** Per-tab slope taken between the smallest and largest point, which must be a whole number. */
function perTab(points: readonly StripMeasurement[], read: (point: StripMeasurement) => number) {
  const first = points[0]
  const last = points.at(-1)!
  return (read(last) - read(first)) / (last.tabs - first.tabs)
}

describe('tab strip presentation residency', () => {
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

  it('renders every dormant tab, at every scale', async () => {
    const points: StripMeasurement[] = []
    for (const tabs of SCALES) {
      points.push(await measureStrip(tabs))
    }

    // Characterization of TODAY, the strip's twin of the rail's: tab-bar-item-surface.tsx maps
    // every item to a SortableTab, so a tab scrolled out of the strip is still a mounted subtree.
    // When that changes, invert this in place.
    expect(points.map((point) => point.tabsInDom)).toEqual([...SCALES])
  })

  it('costs a fixed number of DOM nodes and store subscribers per dormant tab', async () => {
    const points: StripMeasurement[] = []
    for (const tabs of SCALES) {
      points.push(await measureStrip(tabs))
    }

    const domPerTab = perTab(points, (point) => point.domNodes)
    const listenersPerTab = perTab(points, (point) => point.listeners)
    expect(Number.isInteger(domPerTab)).toBe(true)
    expect(Number.isInteger(listenersPerTab)).toBe(true)

    // Predictive, not descriptive: the slope comes from the 1- and 50-tab points and must land the
    // 10-tab point exactly. A sublinear strip (virtualized, pooled, windowed) fails here.
    const domBase = points[0].domNodes - domPerTab
    const listenerBase = points[0].listeners - listenersPerTab
    expect(points.map((point) => point.domNodes)).toEqual(
      points.map((point) => domBase + point.tabs * domPerTab)
    )
    expect(points.map((point) => point.listeners)).toEqual(
      points.map((point) => listenerBase + point.tabs * listenersPerTab)
    )

    // Ratchet, and it is new. This file previously asserted only that the cost was an integer and
    // linear, which is satisfied by any per-tab number at all — so when `lib/tab-agent-projection.ts`
    // took the strip from 21 subscribers per tab to 10, this test passed without noticing either the
    // old figure or the new one. Linearity says the shape is right; only a pinned value says the
    // size is. The rail's twin has carried one since it was written.
    // 10 -> 11: the Resume control beside the agent logo holds one subscription per tab. It answers
    // from an index keyed on the sleeping-records map, so a write that leaves that map alone costs two
    // lookups; folding it into tab-agent-projection would widen that projection's inputs instead.
    expect({ domPerTab, listenersPerTab }).toEqual({ domPerTab: 13, listenersPerTab: 11 })

    const report = { domPerTab, listenersPerTab, points }
    if (process.env.STRIP_RESIDENCY_REPORT) {
      // Vitest swallows console.info, so a measurement that must be read goes to a named file.
      const { writeFileSync } = await import('node:fs')
      writeFileSync(process.env.STRIP_RESIDENCY_REPORT, JSON.stringify(report, null, 2))
    }
    expect(report.points).toHaveLength(SCALES.length)
  })
})
