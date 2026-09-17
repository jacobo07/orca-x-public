import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import {
  resetTerminalTabActivityFlagsCacheForTest,
  resolveTerminalTabActivityStatus
} from './terminal-tab-activity-status'

/**
 * CHARACTERIZATION — a turn longer than the staleness window loses its live state.
 *
 * Agent hooks report at turn boundaries, so a single long turn emits no status update for its whole
 * duration. The freshness gate is a wall-clock test on the last report, so at 30m it drops a
 * `working` row whose agent is still streaming. The title heuristic is the only fallback, and it
 * speaks only for titles that carry agent evidence — a renamed or task-named pane has none.
 *
 * These assertions pin TODAY's behaviour, including the wrong one. When the projection learns to
 * read liveness, LONG-TURN-GOES-QUIET inverts in place and the diff is the evidence.
 */

const TAB_ID = 'tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const NOW = 10_000
const PAST_STALE = 31 * 60 * 1000
const WITHIN_STALE = 29 * 60 * 1000

/** The user's case: a pane named for its task, so the title carries no agent evidence. */
const TASK_NAMED_TAB: Pick<TerminalTab, 'id' | 'title' | 'launchAgent'> = {
  id: TAB_ID,
  title: 'ROLE — KOBIMAPENSADOR'
}

const LIVE_PTY = { [TAB_ID]: ['pty-1'] }

function workingEntry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    paneKey: `${TAB_ID}:${LEAF_ID}`,
    state: 'working',
    prompt: '',
    updatedAt: NOW,
    stateStartedAt: NOW,
    stateHistory: [],
    agentType: 'claude',
    ...overrides
  }
}

function resolveAt(
  elapsedMs: number,
  tab: Pick<TerminalTab, 'id' | 'title' | 'launchAgent'>,
  runtimePaneTitlesByTabId?: Record<string, Record<number, string>>
): string {
  const entry = workingEntry()
  vi.setSystemTime(NOW + elapsedMs)
  return resolveTerminalTabActivityStatus({
    tab,
    agentStatusByPaneKey: { [entry.paneKey]: entry },
    agentStatusEpoch: elapsedMs,
    ptyIdsByTabId: LIVE_PTY,
    runtimePaneTitlesByTabId
  })
}

beforeEach(() => {
  resetTerminalTabActivityFlagsCacheForTest()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
  resetTerminalTabActivityFlagsCacheForTest()
})

describe('a working turn that outlives the staleness window', () => {
  // Positive control: without this the case below could pass on a broken fixture.
  it('CONTROL shows the same pane live while the report is still fresh', () => {
    expect(resolveAt(WITHIN_STALE, TASK_NAMED_TAB)).toBe('working')
  })

  it('LONG-TURN-GOES-QUIET drops a still-running agent to no live state', () => {
    expect(resolveAt(PAST_STALE, TASK_NAMED_TAB)).toBe('active')
  })

  // Why this matters: it is the fallback that rescues the common case, which is why the defect
  // reads as rare — it only surfaces on a pane whose title stopped looking like an agent.
  it('CONTROL shows the title heuristic still rescuing a spinner-titled pane', () => {
    const spinnerTitled = { ...TASK_NAMED_TAB, launchAgent: 'claude' as const }
    expect(resolveAt(PAST_STALE, spinnerTitled, { [TAB_ID]: { 1: '⠋ Sublimating…' } })).toBe(
      'working'
    )
  })
})

describe('the input the projection does not have', () => {
  // The legitimate reason the staleness gate exists: an abandoned pane must de-spin.
  it('CONTROL de-spins a genuinely abandoned pane', () => {
    expect(resolveAt(PAST_STALE, TASK_NAMED_TAB)).toBe('active')
  })

  /**
   * The architectural finding, not a preference: a pane streaming bytes right now and a pane
   * abandoned an hour ago reach this resolver as byte-identical arguments. No fix to the predicate
   * can separate them — every input is a label (a hook report, a title string) and none is evidence
   * that the PTY is producing output. Whatever teaches the dot to tell them apart must add an input.
   */
  it('INDISTINGUISHABLE gives a streaming pane and an abandoned pane the same answer', () => {
    const streaming = resolveAt(PAST_STALE, TASK_NAMED_TAB)
    resetTerminalTabActivityFlagsCacheForTest()
    const abandoned = resolveAt(PAST_STALE, TASK_NAMED_TAB)
    expect(streaming).toBe(abandoned)
  })
})
