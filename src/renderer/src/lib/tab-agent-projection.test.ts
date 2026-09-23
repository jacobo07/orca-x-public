/*
 * The projection must not become one giant object subscription.
 *
 * `selectTabAgentSignals` returns an object, and its consumer subscribes to that object — so a new
 * reference is a re-render. Collapsing thirteen primitive selectors into one object selector is only
 * an improvement if an unchanged tab keeps its reference across a rebuild. Without that, a write
 * touching ONE tab hands every other tab a fresh object and re-renders every row, which is strictly
 * worse than the thirteen selectors it replaced.
 *
 * Nothing else in the estate can see this. The fan-out test counts derivation calls and the
 * residency files count subscribers; both stay green with structural sharing removed. This file is
 * the only thing standing between that mutation and a silent regression.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { resetTabAgentProjectionForTest, selectTabAgentSignals } from './tab-agent-projection'

const initialAppState = useAppStore.getInitialState()

/** Hex-padded so the id stays a valid UUID past nine rows. */
const uuidAt = (prefix: number, n: number): string =>
  `${n.toString(16).padStart(8, '0')}-0000-4000-8000-${prefix.toString(16).padStart(4, '0')}${n
    .toString(16)
    .padStart(8, '0')}`

const WORKTREE_ID = 'repo-1::C:/work/orca'

/**
 * The same shape `use-tab-agent.test.ts` builds. Fully typed on purpose: the first version of this
 * file cast a hand-made object to AgentStatusEntry, which silenced the one error that mattered —
 * the resolver reads `agentType`, and the cast let a fixture with no `agentType` compile. Both
 * assertions then failed against correct code.
 */
function agentStatus(paneKey: string, state: AgentStatusEntry['state']): AgentStatusEntry {
  return {
    state,
    prompt: '',
    updatedAt: 1,
    stateStartedAt: 1,
    agentType: 'codex',
    paneKey,
    stateHistory: []
  }
}

type SeedTab = { id: string; worktreeId: string; leafId: string }

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

const read = (tab: SeedTab) => selectTabAgentSignals(useAppStore.getState(), tab)

/** A working agent on this tab's focused pane, which is what makes its identity resolve. */
function putWorkingAgentOn(tab: SeedTab): void {
  const paneKey = makePaneKey(tab.id, tab.leafId)
  useAppStore.setState({
    agentStatusByPaneKey: { [paneKey]: agentStatus(paneKey, 'working') }
  } as Partial<AppState>)
}

describe('tab agent projection', () => {
  beforeEach(() => {
    useAppStore.setState(initialAppState, true)
    resetTabAgentProjectionForTest()
  })

  it('hands back the identical reference while the store has not moved', () => {
    const [tab] = seedTabs(1)
    // Two reads of one snapshot: the second must be the cache, not a rebuild.
    expect(read(tab)).toBe(read(tab))
  })

  it('keeps every OTHER tab on its old reference when one tab changes', () => {
    const tabs = seedTabs(5)
    const before = tabs.map((tab) => read(tab))

    putWorkingAgentOn(tabs[2])

    const after = tabs.map((tab) => read(tab))

    // Precondition, not decoration: if the agent did not resolve, every row below is unchanged for
    // the wrong reason and the whole case passes vacuously.
    expect(after[2].focusedHookAgent).toBe('codex')

    // The one that moved must be a NEW object — serving a stale identity would be a far worse
    // failure than an extra render.
    expect(after[2]).not.toBe(before[2])

    // ...and every other row must be reference-identical, so React re-renders one row, not five.
    // Delete `reuseIfUnchanged` and this is the assertion that goes red.
    for (const index of [0, 1, 3, 4]) {
      expect(after[index]).toBe(before[index])
    }
  })

  it('rebuilds when an input it reads moves, even if the contents match', () => {
    const [tab] = seedTabs(1)
    const before = read(tab)

    // New reference, same content. The entry's VALUE cannot change, so structural sharing must hand
    // back the same object — this is the case that proves the reuse is keyed on fields, not on luck.
    useAppStore.setState({ agentStatusByPaneKey: {} } as Partial<AppState>)
    expect(read(tab)).toBe(before)
  })

  it('does not let one tab id serve another', () => {
    // Why: the cache is keyed by tab id, and a key collision would be invisible in every other test
    // here because they all seed identical dormant rows.
    const tabs = seedTabs(2)
    putWorkingAgentOn(tabs[1])

    expect(read(tabs[0]).focusedHookAgent).toBeNull()
    expect(read(tabs[1]).focusedHookAgent).toBe('codex')
  })
})
