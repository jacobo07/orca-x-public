/*
 * The projection's counters are the REAL APP's only instrument, so they are pinned here first.
 *
 * `components/terminal-rail/terminal-rail-derivation-fanout.test.tsx` counts the identity ladder by
 * wrapping `lib/tab-agent` with `vi.mock`. A packaged Electron renderer cannot be mocked, so
 * `tests/e2e/dormant-derivation-reality.spec.ts` reads these counters instead — and the number it
 * asserts on is a ZERO. A counter that silently stopped counting produces that zero too, and is
 * indistinguishable from the projection working, which is exactly the failure the e2e exists to
 * exclude. So the counters are proven to move, here, against the same store the product uses,
 * before any run is allowed to read a zero out of them.
 *
 * Both poles in every case: a relevant write costs the full per-row derivation, an unrelated write
 * costs none, and the two are asserted in the same file with the same counters.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'
import {
  readTabAgentProjectionCounters,
  resetTabAgentProjectionCounters,
  resetTabAgentProjectionForTest,
  selectTabAgentSignals
} from './tab-agent-projection'

const initialAppState = useAppStore.getInitialState()
const ROWS = 5
const WORKTREE_ID = 'repo-1::C:/work/orca'

/** Hex-padded so the id stays a valid UUID past nine rows. */
const uuidAt = (prefix: number, n: number): string =>
  `${n.toString(16).padStart(8, '0')}-0000-4000-8000-${prefix.toString(16).padStart(4, '0')}${n
    .toString(16)
    .padStart(8, '0')}`

type SeedTab = { id: string; worktreeId: string; leafId: string }

/** ROWS dormant rows as restore leaves them: a layout naming a pane, and no PTY anywhere. */
function seedTabs(count: number): SeedTab[] {
  const tabs = Array.from({ length: count }, (_, index) => ({
    id: uuidAt(0xaaa, index),
    worktreeId: WORKTREE_ID,
    leafId: uuidAt(0xbbb, index)
  }))
  const terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot> = {}
  for (const tab of tabs) {
    terminalLayoutsByTabId[tab.id] = {
      root: { type: 'leaf', leafId: tab.leafId },
      activeLeafId: tab.leafId,
      expandedLeafId: null
    }
  }
  useAppStore.setState({ terminalLayoutsByTabId } as Partial<AppState>)
  return tabs
}

/** What a mounted rail does on every notification: every row asks the projection once. */
function readAllRows(tabs: SeedTab[]): void {
  for (const tab of tabs) {
    selectTabAgentSignals(useAppStore.getState(), tab)
  }
}

describe('tab agent projection counters', () => {
  beforeEach(() => {
    useAppStore.setState(initialAppState, true)
    resetTabAgentProjectionForTest()
    resetTabAgentProjectionCounters()
  })

  it('counts one derivation and one pane key per row that actually derives', () => {
    // The instrument's liveness proof. Every zero asserted below and in the e2e is only meaningful
    // because this case shows the same counters reaching a non-zero number through the same path.
    const tabs = seedTabs(ROWS)
    readAllRows(tabs)

    const counters = readTabAgentProjectionCounters()
    expect(counters.derivations).toBe(ROWS)
    expect(counters.paneKeys).toBe(ROWS)
    expect(counters.generations).toBe(1)
    expect(counters.cacheHits).toBe(0)
  })

  it('derives nothing for any row on a store write it does not depend on', () => {
    const tabs = seedTabs(ROWS)
    readAllRows(tabs)
    resetTabAgentProjectionCounters()

    // A write about the side panel says nothing about any terminal.
    useAppStore.setState({ rightSidebarOpen: true } as Partial<AppState>)
    readAllRows(tabs)

    const counters = readTabAgentProjectionCounters()
    expect(counters.generations).toBe(0)
    expect(counters.derivations).toBe(0)
    expect(counters.paneKeys).toBe(0)
    // Not merely "did not derive": every row was genuinely asked, so a rail that had quietly
    // unmounted cannot pass this as if it were the projection working.
    expect(counters.cacheHits).toBe(ROWS)
  })

  it('derives every row again when an input it reads moves', () => {
    const tabs = seedTabs(ROWS)
    readAllRows(tabs)
    resetTabAgentProjectionCounters()

    // New reference, content-equal on purpose: the derivation must re-run even though no row's
    // VALUE can change, which is what makes the reuse counter below the interesting half.
    useAppStore.setState({ agentStatusByPaneKey: {} } as Partial<AppState>)
    readAllRows(tabs)

    const counters = readTabAgentProjectionCounters()
    expect(counters.generations).toBe(1)
    expect(counters.derivations).toBe(ROWS)
    expect(counters.paneKeys).toBe(ROWS)
    // Necessary derivation still runs; unnecessary INVALIDATION does not. Removing
    // `reuseIfUnchanged` leaves the two counts above intact and turns this one into zero.
    expect(counters.reusedReferences).toBe(ROWS)
  })

  it('flips the generation when the store universe is replaced under it', () => {
    // Why this matters more than a thrash: entries are keyed by tab id alone, in a module-global
    // map. A profile or workspace switch that did NOT flip the generation could serve one universe's
    // identity to another's tab of the same id — worse than any amount of repeated work.
    const tabs = seedTabs(ROWS)
    readAllRows(tabs)
    resetTabAgentProjectionCounters()

    useAppStore.setState({ repos: [] } as Partial<AppState>)
    readAllRows(tabs)

    const counters = readTabAgentProjectionCounters()
    expect(counters.generations).toBe(1)
    expect(counters.derivations).toBe(ROWS)
  })
})
