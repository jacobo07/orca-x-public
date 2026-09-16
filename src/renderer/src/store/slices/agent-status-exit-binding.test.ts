import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore, makeTab } from './store-test-helpers'

// Characterization: what the pane's resume binding looks like after the agent
// process exits back to its shell. Asserts today's behaviour on purpose.

const PANE = 'tab-1:leaf-1'
const SESSION_A = { key: 'session_id' as const, id: 'claude-session-a' }
const SESSION_B = { key: 'session_id' as const, id: 'claude-session-b' }

function seedFinishedClaudeTurn(providerSession: typeof SESSION_A, at: number) {
  const store = createTestStore()
  store.setState({
    tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] }
  })
  const meta = { tabId: 'tab-1', worktreeId: 'wt-1' }
  store
    .getState()
    .setAgentStatus(
      PANE,
      { state: 'working', prompt: 'refactor', agentType: 'claude' },
      'Claude',
      { updatedAt: at, stateStartedAt: at },
      meta,
      { providerSession }
    )
  store
    .getState()
    .setAgentStatus(
      PANE,
      { state: 'done', prompt: 'refactor', agentType: 'claude' },
      'Claude',
      { updatedAt: at + 1, stateStartedAt: at + 1 },
      meta
    )
  return store
}

describe('agent exit leaves the pane resume binding', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('control: a finished resumable turn writes a live recovery record', () => {
    const store = seedFinishedClaudeTurn(SESSION_A, 10)

    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE]).toMatchObject({
      paneKey: PANE,
      worktreeId: 'wt-1',
      agent: 'claude',
      providerSession: SESSION_A,
      origin: 'live'
    })
  })

  it('keeps the exact provider session after the exit drop', () => {
    const store = seedFinishedClaudeTurn(SESSION_A, 10)

    store.getState().dropAgentStatus(PANE)

    const s = store.getState()
    expect(s.agentStatusByPaneKey[PANE]).toBeUndefined()
    expect(s.sleepingAgentSessionsByPaneKey[PANE]?.providerSession).toEqual(SESSION_A)
  })

  // CHARACTERIZATION (D1): the surviving record cannot say the agent exited.
  // W2 inverts this: the record must carry why the runtime is absent.
  it('records the exited agent exactly as a live working agent', () => {
    const store = seedFinishedClaudeTurn(SESSION_A, 10)

    store.getState().dropAgentStatus(PANE)

    const record = store.getState().sleepingAgentSessionsByPaneKey[PANE]
    expect(record?.origin).toBe('live')
    expect(record?.state).toBe('working')
    expect(Object.keys(record ?? {}).some((key) => /absen|exit/i.test(key))).toBe(false)
  })

  // Decision 3 (approved 2026-09-16): a new agent in the same pane replaces the binding.
  it('replaces the binding when a new provider session starts in the same pane', () => {
    const store = seedFinishedClaudeTurn(SESSION_A, 10)
    store.getState().dropAgentStatus(PANE)

    store
      .getState()
      .setAgentStatus(
        PANE,
        { state: 'working', prompt: 'next task', agentType: 'claude' },
        'Claude',
        { updatedAt: 30, stateStartedAt: 30 },
        { tabId: 'tab-1', worktreeId: 'wt-1' },
        { providerSession: SESSION_B }
      )

    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE]?.providerSession).toEqual(
      SESSION_B
    )
  })
})
