import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { TERMINAL_OUTPUT_LIVENESS_WINDOW_MS } from '@/lib/terminal-output-recency'
import {
  resetTerminalTabActivityFlagsCacheForTest,
  resolveTerminalTabActivityStatus
} from './terminal-tab-activity-status'

/**
 * A turn longer than the staleness window keeps its live state while its PTY is still producing.
 *
 * Agent hooks report at turn boundaries, so a long turn emits no status update while it runs, and
 * the wall-clock freshness gate cannot tell it from an abandoned pane. Observed output is the input
 * that separates them. It holds an existing state open; it never invents one.
 *
 * This file previously pinned the opposite — LONG-TURN-GOES-QUIET, and an INDISTINGUISHABLE case
 * asserting a streaming and an abandoned pane got the same answer. Both are inverted here rather
 * than deleted, so the diff carries the fix.
 */

const TAB_ID = 'tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`
const NOW = 10_000
const PAST_STALE = 31 * 60 * 1000
const WITHIN_STALE = 29 * 60 * 1000

/** The user's case: a pane named for its task, so the title carries no agent evidence. */
const TASK_NAMED_TAB: Pick<TerminalTab, 'id' | 'title' | 'launchAgent'> = {
  id: TAB_ID,
  title: 'ROLE — KOBIMAPENSADOR'
}

const LIVE_PTY = { [TAB_ID]: ['pty-1'] }

function entry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    paneKey: PANE_KEY,
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
  options: {
    tab?: Pick<TerminalTab, 'id' | 'title' | 'launchAgent'>
    state?: AgentStatusEntry['state']
    /** Age of the newest observed output at read time; omitted means nothing was ever observed. */
    outputAgeMs?: number
    withoutAgentEntry?: boolean
    runtimePaneTitlesByTabId?: Record<string, Record<number, string>>
  } = {}
): string {
  const now = NOW + elapsedMs
  vi.setSystemTime(now)
  const row = entry({ state: options.state ?? 'working' })
  return resolveTerminalTabActivityStatus({
    tab: options.tab ?? TASK_NAMED_TAB,
    agentStatusByPaneKey: options.withoutAgentEntry ? {} : { [row.paneKey]: row },
    agentStatusEpoch: elapsedMs,
    ptyIdsByTabId: LIVE_PTY,
    runtimePaneTitlesByTabId: options.runtimePaneTitlesByTabId,
    lastTerminalOutputAtByPaneKey:
      options.outputAgeMs === undefined ? undefined : { [PANE_KEY]: now - options.outputAgeMs }
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
  // Positive control: without this the cases below could pass on a broken fixture.
  it('CONTROL shows the same pane live while the report is still fresh', () => {
    expect(resolveAt(WITHIN_STALE)).toBe('working')
  })

  it('LONG-TURN-STAYS-LIVE keeps a still-streaming agent live past the window', () => {
    expect(resolveAt(PAST_STALE, { outputAgeMs: 1_000 })).toBe('working')
  })

  it('CONTROL shows the title heuristic still rescuing a spinner-titled pane', () => {
    expect(
      resolveAt(PAST_STALE, {
        tab: { ...TASK_NAMED_TAB, launchAgent: 'claude' },
        runtimePaneTitlesByTabId: { [TAB_ID]: { 1: '⠋ Sublimating…' } }
      })
    ).toBe('working')
  })
})

describe('what output may and may not do', () => {
  // The reason the staleness gate exists. Output is the only thing that may hold it open.
  it('CONTROL de-spins an abandoned pane that is not producing output', () => {
    expect(resolveAt(PAST_STALE)).toBe('active')
  })

  it('DISTINGUISHABLE separates a streaming pane from an abandoned one', () => {
    const streaming = resolveAt(PAST_STALE, { outputAgeMs: 1_000 })
    resetTerminalTabActivityFlagsCacheForTest()
    const abandoned = resolveAt(PAST_STALE)
    expect(streaming).toBe('working')
    expect(abandoned).toBe('active')
    expect(streaming).not.toBe(abandoned)
  })

  // Why bounded: a `done` hook that never arrived must not let later shell output spin forever.
  it('de-spins once output stops, after the liveness window', () => {
    expect(resolveAt(PAST_STALE, { outputAgeMs: TERMINAL_OUTPUT_LIVENESS_WINDOW_MS + 1_000 })).toBe(
      'active'
    )
  })

  it('does not revive a completed turn from later output', () => {
    expect(resolveAt(PAST_STALE, { state: 'done', outputAgeMs: 1_000 })).toBe('active')
  })

  // Output is evidence a state still holds, never evidence of what the state is.
  it('does not invent a working state for a pane with no agent row', () => {
    expect(resolveAt(PAST_STALE, { withoutAgentEntry: true, outputAgeMs: 1_000 })).toBe('active')
  })

  it('keeps a needs-input turn actionable while it streams', () => {
    expect(resolveAt(PAST_STALE, { state: 'blocked', outputAgeMs: 1_000 })).toBe('permission')
  })

  // A clock that moved backwards must not read as fresher than now.
  it('ignores an output stamp from the future', () => {
    expect(resolveAt(PAST_STALE, { outputAgeMs: -60_000 })).toBe('active')
  })
})
