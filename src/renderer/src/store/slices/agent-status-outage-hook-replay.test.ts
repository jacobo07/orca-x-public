import { afterEach, describe, expect, it, vi } from 'vitest'

import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'
import { isExplicitAgentStatusFresh } from '../../lib/pane-agent-evidence'
import { createTestStore } from './store-test-helpers'

const HOOK_PANE = 'tab-hook:11111111-1111-4111-8111-111111111111'

type Store = ReturnType<typeof createTestStore>

function sshState(status: SshConnectionStatus) {
  return { targetId: 'ssh-a', status, error: null, reconnectAttempt: 0 }
}

function postHook(store: Store, prompt: string): void {
  store
    .getState()
    .setAgentStatus(
      HOOK_PANE,
      { state: 'working', prompt, agentType: 'claude' },
      undefined,
      { updatedAt: Date.now() },
      { connectionId: 'ssh-a' }
    )
}

// Replays the ordering of the lost phase-15 attempts at the store boundary, through the
// actions the app calls: a hook row lands, optionally a typed command, the transport is lost and
// re-established, then a hook that was posted during the outage is replayed after reattach.
function runOutageOrdering(
  typed: 'nothing' | 'typed-command' | 'typed-command-then-finished',
  tweakStore?: (store: Store) => void
): Record<string, unknown> {
  vi.useFakeTimers()
  vi.setSystemTime(2_000_000)
  const store = createTestStore()
  tweakStore?.(store)
  store.getState().setSshConnectionState('ssh-a', sshState('connected'))
  postHook(store, 'row landed')
  const rowAfterLanding = store.getState().agentStatusByPaneKey[HOOK_PANE] !== undefined

  vi.setSystemTime(2_001_000)
  if (typed !== 'nothing') {
    store.getState().recordTerminalInput(HOOK_PANE, Date.now())
  }
  if (typed === 'typed-command-then-finished') {
    // pty-connection's command-finished handler reacts to a finished typed command with this action.
    store.getState().dropAgentStatus(HOOK_PANE)
  }
  const rowBeforeKill = store.getState().agentStatusByPaneKey[HOOK_PANE] !== undefined

  vi.setSystemTime(2_002_000)
  store.getState().setSshConnectionState('ssh-a', sshState('reconnecting'))
  store.getState().clearTransientAgentStatuses('ssh-a', Date.now())

  // The outage hook is posted by the in-pane script while the client is detached, then replayed.
  vi.setSystemTime(2_010_000)
  store.getState().setSshConnectionState('ssh-a', sshState('connected'))
  vi.setSystemTime(2_010_500)
  postHook(store, 'posted during the outage')

  const row = store.getState().agentStatusByPaneKey[HOOK_PANE]
  return {
    rowAfterLanding,
    rowBeforeKill,
    rowAfterReplay: row !== undefined,
    replayedContent: row?.prompt,
    fresh: row ? isExplicitAgentStatusFresh(row, Date.now(), AGENT_STATUS_STALE_AFTER_MS) : false,
    unverified: row?.restoredUnconfirmed === true
  }
}

describe('hook posted during an outage, replayed after reattach', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('control: with nothing typed the replayed hook is a fresh row with the replayed content', () => {
    expect(runOutageOrdering('nothing')).toEqual({
      rowAfterLanding: true,
      rowBeforeKill: true,
      rowAfterReplay: true,
      replayedContent: 'posted during the outage',
      fresh: true,
      unverified: false
    })
  })

  it('a command typed after the row landed changes nothing in the store: same outcome with and without it', () => {
    // Why: recordTerminalInput (the typed-input store action) has no reaction in the agent-status slice.
    expect(runOutageOrdering('typed-command')).toEqual(runOutageOrdering('nothing'))
  })

  it('detector control: a typed-input action that did clear the row would make the with/without comparison differ', () => {
    const typedInputClearsRow = (store: Store): void => {
      store.setState({
        recordTerminalInput: (paneKey: string) => store.getState().removeAgentStatus(paneKey)
      })
    }
    expect(runOutageOrdering('typed-command', typedInputClearsRow)).not.toEqual(
      runOutageOrdering('nothing')
    )
  })

  it('a typed command that finished (row dropped before the kill) still ends with the replayed hook as a fresh row', () => {
    // Why: this reproduces "the row was already gone before the kill" and shows the store accepts the later replay.
    expect(runOutageOrdering('typed-command-then-finished')).toEqual({
      rowAfterLanding: true,
      rowBeforeKill: false,
      rowAfterReplay: true,
      replayedContent: 'posted during the outage',
      fresh: true,
      unverified: false
    })
  })
})
