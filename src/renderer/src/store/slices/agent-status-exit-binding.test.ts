import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore, makeTab } from './store-test-helpers'
import {
  isAgentExitedResumeBlock,
  isLegacyWorkerResumeBlock
} from '../../../../shared/agent-resume-block-precedence'

// What the pane's resume binding looks like after the agent process exits back
// to its shell: identity kept, automatic relaunch blocked (D1, W2).

const PANE = 'tab-1:leaf-1'
const SESSION_A = { key: 'session_id' as const, id: 'claude-session-a' }
const SESSION_B = { key: 'session_id' as const, id: 'claude-session-b' }
const META = { tabId: 'tab-1', worktreeId: 'wt-1' }

function seedFinishedClaudeTurn(providerSession: typeof SESSION_A, at: number) {
  const store = createTestStore()
  store.setState({
    tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] }
  })
  store
    .getState()
    .setAgentStatus(
      PANE,
      { state: 'working', prompt: 'refactor', agentType: 'claude' },
      'Claude',
      { updatedAt: at, stateStartedAt: at },
      META,
      { providerSession }
    )
  store
    .getState()
    .setAgentStatus(
      PANE,
      { state: 'done', prompt: 'refactor', agentType: 'claude' },
      'Claude',
      { updatedAt: at + 1, stateStartedAt: at + 1 },
      META
    )
  return store
}

function exitAgent(store: ReturnType<typeof createTestStore>, at: number): void {
  vi.setSystemTime(at)
  store.getState().dropAgentStatus(PANE)
  store.getState().markSleepingAgentExited(PANE)
}

function reportSession(
  store: ReturnType<typeof createTestStore>,
  providerSession: typeof SESSION_A,
  at: number
): void {
  store
    .getState()
    .setAgentStatus(
      PANE,
      { state: 'working', prompt: 'next task', agentType: 'claude' },
      'Claude',
      { updatedAt: at, stateStartedAt: at },
      META,
      { providerSession }
    )
}

describe('agent exit leaves the pane resume binding', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(5)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('control: a finished resumable turn writes an unblocked live recovery record', () => {
    const store = seedFinishedClaudeTurn(SESSION_A, 10)

    const record = store.getState().sleepingAgentSessionsByPaneKey[PANE]
    expect(record).toMatchObject({
      paneKey: PANE,
      worktreeId: 'wt-1',
      agent: 'claude',
      providerSession: SESSION_A,
      origin: 'live'
    })
    expect(record?.automaticResumeBlockedBy).toBeUndefined()
  })

  it('keeps the exact provider session after the exit', () => {
    const store = seedFinishedClaudeTurn(SESSION_A, 10)

    exitAgent(store, 20)

    const s = store.getState()
    expect(s.agentStatusByPaneKey[PANE]).toBeUndefined()
    expect(s.sleepingAgentSessionsByPaneKey[PANE]?.providerSession).toEqual(SESSION_A)
  })

  it('records that the agent exited, so nothing relaunches it automatically', () => {
    const store = seedFinishedClaudeTurn(SESSION_A, 10)

    exitAgent(store, 20)

    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE]).toMatchObject({
      origin: 'live',
      automaticResumeBlockedBy: 'agent-exited',
      updatedAt: 20
    })
  })

  it('a provider-session report from before the exit does not lift the block', () => {
    const store = seedFinishedClaudeTurn(SESSION_A, 10)
    exitAgent(store, 20)

    reportSession(store, SESSION_A, 15)

    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE]?.automaticResumeBlockedBy).toBe(
      'agent-exited'
    )
  })

  // W3.0: status reports reach the record through a comparator that ignored the block, so
  // resuming the same session kept the exit and a crash would not bring the agent back.
  it('the same session reporting again after the exit lifts the block', () => {
    const store = seedFinishedClaudeTurn(SESSION_A, 10)
    exitAgent(store, 20)

    reportSession(store, SESSION_A, 30)

    const record = store.getState().sleepingAgentSessionsByPaneKey[PANE]
    expect(record?.providerSession).toEqual(SESSION_A)
    expect(record?.automaticResumeBlockedBy).toBeUndefined()
  })

  // Decision 3 (approved 2026-09-16): a new agent in the same pane replaces the binding.
  it('a new provider session in the same pane replaces the binding and lifts the block', () => {
    const store = seedFinishedClaudeTurn(SESSION_A, 10)
    exitAgent(store, 20)

    reportSession(store, SESSION_B, 30)

    const record = store.getState().sleepingAgentSessionsByPaneKey[PANE]
    expect(record?.providerSession).toEqual(SESSION_B)
    expect(record?.automaticResumeBlockedBy).toBeUndefined()
  })

  it('releasing the legacy orchestration fence leaves an exit block in place', () => {
    const store = seedFinishedClaudeTurn(SESSION_A, 10)
    exitAgent(store, 20)

    store.getState().setSleepingAgentAutomaticResumeBlocked(PANE, false)

    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE]?.automaticResumeBlockedBy).toBe(
      'agent-exited'
    )
  })

  // W3.0: one scalar held both reasons, so fencing an exited pane and releasing the fence
  // made it automatically resumable again.
  it('fencing then releasing a legacy worker keeps an earlier exit', () => {
    const store = seedFinishedClaudeTurn(SESSION_A, 10)
    exitAgent(store, 20)

    store.getState().setSleepingAgentAutomaticResumeBlocked(PANE, true)
    const fenced = store.getState().sleepingAgentSessionsByPaneKey[PANE]?.automaticResumeBlockedBy
    store.getState().setSleepingAgentAutomaticResumeBlocked(PANE, false)

    expect(isLegacyWorkerResumeBlock(fenced)).toBe(true)
    expect(isAgentExitedResumeBlock(fenced)).toBe(true)
    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE]?.automaticResumeBlockedBy).toBe(
      'agent-exited'
    )
  })

  it('an exit on a fenced legacy worker is recorded without lifting the fence', () => {
    const store = seedFinishedClaudeTurn(SESSION_A, 10)
    store.getState().setSleepingAgentAutomaticResumeBlocked(PANE, true)

    exitAgent(store, 20)
    const blockedBy =
      store.getState().sleepingAgentSessionsByPaneKey[PANE]?.automaticResumeBlockedBy

    expect(isLegacyWorkerResumeBlock(blockedBy)).toBe(true)
    expect(isAgentExitedResumeBlock(blockedBy)).toBe(true)
  })

  // Pi reports its session through recordAgentProviderSession, not setAgentStatus.
  it('a Pi session report on a fenced exited pane keeps the fence and lifts the exit', () => {
    const store = createTestStore()
    store.setState({
      tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] }
    })
    const piSession = {
      key: 'session_id' as const,
      id: 'pi-session',
      transcriptPath: '/tmp/pi-session.jsonl'
    }
    store.getState().recordAgentProviderSession(PANE, 'pi', piSession, { updatedAt: 10 }, META)
    exitAgent(store, 20)
    store.getState().setSleepingAgentAutomaticResumeBlocked(PANE, true)

    store.getState().recordAgentProviderSession(PANE, 'pi', piSession, { updatedAt: 30 }, META)

    const record = store.getState().sleepingAgentSessionsByPaneKey[PANE]
    expect(record?.updatedAt).toBe(30)
    expect(record?.automaticResumeBlockedBy).toBe('legacy-orchestration-worker')
  })

  it('a live report on a fenced exited pane keeps the fence and lifts the exit', () => {
    const store = seedFinishedClaudeTurn(SESSION_A, 10)
    exitAgent(store, 20)
    store.getState().setSleepingAgentAutomaticResumeBlocked(PANE, true)

    reportSession(store, SESSION_A, 30)

    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE]?.automaticResumeBlockedBy).toBe(
      'legacy-orchestration-worker'
    )
  })
})
