import { afterEach, describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

const initialAppStoreState = useAppStore.getState()

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
})

function record(paneKey: string, id: string, extra: Partial<SleepingAgentSessionRecord> = {}) {
  return {
    paneKey,
    tabId: paneKey.split(':')[0],
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id },
    prompt: 'finish the task',
    state: 'working',
    origin: 'quit',
    capturedAt: 10,
    updatedAt: 10,
    ...extra
  } as SleepingAgentSessionRecord
}

function seed(records: SleepingAgentSessionRecord[]): void {
  useAppStore.setState({
    tabsByWorktree: { 'wt-1': [] },
    sleepingAgentSessionsByPaneKey: Object.fromEntries(records.map((r) => [r.paneKey, r]))
  } as never)
}

describe('resumeSleepingAgentSessionsForWorktree onlyPaneKeys', () => {
  it('launches only the selected record and leaves every other record exactly as it was', () => {
    const chosen = record('gone-a:leaf', 'sess-a')
    const other = record('gone-b:leaf', 'sess-b')
    // A record the ordinary pass would clear as stale; a selected resume must not tidy it away.
    const stale = record('gone-c:leaf', 'sess-c', { capturedAt: 10_000_000, updatedAt: 1 })
    seed([chosen, other, stale])

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1', {
      onlyPaneKeys: new Set([chosen.paneKey])
    })

    expect(launched).toBe(1)
    const state = useAppStore.getState()
    expect(state.sleepingAgentSessionsByPaneKey[chosen.paneKey]).toBeUndefined()
    expect(state.sleepingAgentSessionsByPaneKey[other.paneKey]).toBe(other)
    expect(state.sleepingAgentSessionsByPaneKey[stale.paneKey]).toBe(stale)
    expect(state.tabsByWorktree['wt-1']).toHaveLength(1)
  })

  it('control: without the filter both resumable records launch', () => {
    seed([record('gone-a:leaf', 'sess-a'), record('gone-b:leaf', 'sess-b')])
    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(2)
  })
})
