import { afterEach, describe, expect, it, vi } from 'vitest'

import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'
import { isExplicitAgentStatusFresh } from '../../lib/pane-agent-evidence'
import type { AppState } from '../types'
import {
  CONNECTION_STATUSES_THAT_RETAIN_ROWS,
  shouldRetainRowsOnConnectionLoss
} from './agent-status-reconnect-retention'
import { createTestStore } from './store-test-helpers'

const PANE = 'tab-a:11111111-1111-4111-8111-111111111111'
const OTHER_HOST_PANE = 'tab-b:22222222-2222-4222-8222-222222222222'
const FOLDER_PANE = 'tab-f:33333333-3333-4333-8333-333333333333'

function sshState(status: SshConnectionStatus, targetId = 'ssh-a') {
  return { targetId, status, error: null, reconnectAttempt: 0 }
}

function hookRow(store: ReturnType<typeof createTestStore>, paneKey: string, prompt: string) {
  store
    .getState()
    .setAgentStatus(
      paneKey,
      { state: 'working', prompt, agentType: 'claude' },
      undefined,
      { updatedAt: Date.now() },
      { connectionId: paneKey === OTHER_HOST_PANE ? 'ssh-b' : 'ssh-a' }
    )
}

describe('a live agent row across SSH re-establishment', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('stays present at every step of connected, reconnecting, connected and is stale until a replayed hook', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const store = createTestStore()
    const removeAgentStatus = vi.fn(store.getState().removeAgentStatus)
    const dropAgentStatus = vi.fn(store.getState().dropAgentStatus)
    store.setState({ removeAgentStatus, dropAgentStatus } as Partial<AppState>)
    const timersBefore = vi.getTimerCount()

    const presence: Record<string, boolean> = {}
    const record = (step: string): void => {
      presence[step] = store.getState().agentStatusByPaneKey[PANE] !== undefined
    }

    store.getState().setSshConnectionState('ssh-a', sshState('connected'))
    hookRow(store, PANE, 'before the outage')
    record('1 hook row lands while connected')

    vi.setSystemTime(1_001_500)
    store.getState().setSshConnectionState('ssh-a', sshState('reconnecting'))
    record('2 setSshConnectionState(reconnecting)')

    // The main process emits this transient clear when the relay session tears down on connection loss.
    store.getState().clearTransientAgentStatuses('ssh-a', Date.now())
    record('3 clearTransientAgentStatuses(ssh-a) from the lost transport')

    const duringOutage = store.getState().agentStatusByPaneKey[PANE]
    store.getState().setSshConnectionState('ssh-a', sshState('connected'))
    record('4 setSshConnectionState(connected)')

    // The phase-15 instrument watched only these two removal actions; neither is the hider.
    expect(removeAgentStatus).toHaveBeenCalledTimes(0)
    expect(dropAgentStatus).toHaveBeenCalledTimes(0)
    expect(presence).toEqual({
      '1 hook row lands while connected': true,
      '2 setSshConnectionState(reconnecting)': true,
      '3 clearTransientAgentStatuses(ssh-a) from the lost transport': true,
      '4 setSshConnectionState(connected)': true
    })

    // Unverified during re-establishment: present, never read as live-healthy.
    expect(duringOutage?.prompt).toBe('before the outage')
    expect(duringOutage?.restoredUnconfirmed).toBe(true)
    expect(isExplicitAgentStatusFresh(duringOutage!, Date.now(), AGENT_STATUS_STALE_AFTER_MS)).toBe(
      false
    )

    // Still unverified after connected until a hook proves the agent is alive.
    const afterConnected = store.getState().agentStatusByPaneKey[PANE]
    expect(
      isExplicitAgentStatusFresh(afterConnected!, Date.now(), AGENT_STATUS_STALE_AFTER_MS)
    ).toBe(false)

    vi.setSystemTime(1_003_000)
    hookRow(store, PANE, 'replayed after reattach')
    const replayed = store.getState().agentStatusByPaneKey[PANE]
    expect(replayed?.prompt).toBe('replayed after reattach')
    expect(replayed?.restoredUnconfirmed).toBeUndefined()
    expect(isExplicitAgentStatusFresh(replayed!, Date.now(), AGENT_STATUS_STALE_AFTER_MS)).toBe(
      true
    )
    // Event-driven: retention adds no timer of its own.
    expect(vi.getTimerCount()).toBeLessThanOrEqual(timersBefore + 1)
  })

  it.each(['reconnection-failed', 'auth-failed', 'disconnected', 'error'] as const)(
    'control: a permanent loss (%s) still clears the connection rows in one update',
    (status) => {
      vi.useFakeTimers()
      vi.setSystemTime(1_000_000)
      const store = createTestStore()
      store.getState().setSshConnectionState('ssh-a', sshState('connected'))
      hookRow(store, PANE, 'doomed')
      store.getState().setSshConnectionState('ssh-a', sshState(status))

      store.getState().clearTransientAgentStatuses('ssh-a', Date.now())

      expect(store.getState().agentStatusByPaneKey[PANE]).toBeUndefined()
    }
  )

  it.each(['reconnection-failed', 'auth-failed', 'disconnected', 'error'] as const)(
    'a row retained through a transient loss is cleared when the connection then ends in %s',
    (status) => {
      vi.useFakeTimers()
      vi.setSystemTime(1_000_000)
      const store = createTestStore()
      store.getState().setSshConnectionState('ssh-a', sshState('connected'))
      hookRow(store, PANE, 'retained then lost for good')
      store.getState().setSshConnectionState('ssh-a', sshState('reconnecting'))
      store.getState().clearTransientAgentStatuses('ssh-a', Date.now())
      expect(store.getState().agentStatusByPaneKey[PANE]).toBeDefined()

      store.getState().setSshConnectionState('ssh-a', sshState(status))

      expect(store.getState().agentStatusByPaneKey[PANE]).toBeUndefined()
    }
  )

  it('keeps the row when the transport-loss clear beats the state event, then clears if the loss turns permanent', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const store = createTestStore()
    store.getState().setSshConnectionState('ssh-a', sshState('connected'))
    hookRow(store, PANE, 'clear first')

    store.getState().clearTransientAgentStatuses('ssh-a', Date.now())
    expect(store.getState().agentStatusByPaneKey[PANE]?.restoredUnconfirmed).toBe(true)

    store.getState().setSshConnectionState('ssh-a', sshState('reconnection-failed'))
    expect(store.getState().agentStatusByPaneKey[PANE]).toBeUndefined()
  })

  it('control: an explicit disconnect with no earlier transport loss does not touch rows it never retained', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const store = createTestStore()
    store.getState().setSshConnectionState('ssh-a', sshState('connected'))
    hookRow(store, PANE, 'untouched by the slice')

    store.getState().setSshConnectionState('ssh-a', sshState('disconnected'))

    expect(store.getState().agentStatusByPaneKey[PANE]?.prompt).toBe('untouched by the slice')
    expect(store.getState().transientClearedAgentStatusConnectionIds['ssh-a']).toBeUndefined()
  })

  it('keeps a finished (done) row as it was: there is no turn left to doubt', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const store = createTestStore()
    store.getState().setSshConnectionState('ssh-a', sshState('reconnecting'))
    store
      .getState()
      .setAgentStatus(
        PANE,
        { state: 'done', prompt: 'finished', agentType: 'claude' },
        undefined,
        { updatedAt: Date.now() },
        { connectionId: 'ssh-a' }
      )

    store.getState().clearTransientAgentStatuses('ssh-a', Date.now())

    const row = store.getState().agentStatusByPaneKey[PANE]
    expect(row?.state).toBe('done')
    expect(row?.restoredUnconfirmed).toBeUndefined()
  })

  it('control: a row newer than the cutoff is untouched and not marked stale', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const store = createTestStore()
    store.getState().setSshConnectionState('ssh-a', sshState('reconnecting'))
    hookRow(store, PANE, 'newer than cutoff')

    store.getState().clearTransientAgentStatuses('ssh-a', Date.now() - 1)

    expect(store.getState().agentStatusByPaneKey[PANE]?.restoredUnconfirmed).toBeUndefined()
  })

  it("re-establishing one host leaves another host's row neither removed nor stale", () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const store = createTestStore()
    store.getState().setSshConnectionState('ssh-a', sshState('connected'))
    store.getState().setSshConnectionState('ssh-b', sshState('connected', 'ssh-b'))
    hookRow(store, PANE, 'host a')
    hookRow(store, OTHER_HOST_PANE, 'host b')
    store.getState().setSshConnectionState('ssh-a', sshState('reconnecting'))

    store.getState().clearTransientAgentStatuses('ssh-a', Date.now())

    expect(store.getState().agentStatusByPaneKey[PANE]?.restoredUnconfirmed).toBe(true)
    const hostB = store.getState().agentStatusByPaneKey[OTHER_HOST_PANE]
    expect(hostB?.prompt).toBe('host b')
    expect(hostB?.restoredUnconfirmed).toBeUndefined()
    expect(isExplicitAgentStatusFresh(hostB!, Date.now(), AGENT_STATUS_STALE_AFTER_MS)).toBe(true)
  })

  it('a folder-workspace row (unstamped, proven on the host by its folder worktree) follows the same rule', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const store = createTestStore()
    store.setState({
      repos: [
        {
          id: 'folder-repo',
          path: '/srv/notes',
          displayName: 'notes',
          badgeColor: '#000',
          addedAt: 0,
          kind: 'folder',
          connectionId: 'ssh-a'
        }
      ],
      worktreesByRepo: {
        'folder-repo': [{ id: 'folder-repo::/srv/notes', repoId: 'folder-repo' }]
      }
    } as unknown as Partial<AppState>)
    store
      .getState()
      .setAgentStatus(
        FOLDER_PANE,
        { state: 'working', prompt: 'folder agent', agentType: 'claude' },
        undefined,
        { updatedAt: Date.now() },
        { worktreeId: 'folder-repo::/srv/notes' }
      )
    store.getState().setSshConnectionState('ssh-a', sshState('reconnecting'))

    store.getState().clearTransientAgentStatuses('ssh-a', Date.now())
    expect(store.getState().agentStatusByPaneKey[FOLDER_PANE]?.restoredUnconfirmed).toBe(true)

    store.getState().setSshConnectionState('ssh-a', sshState('reconnection-failed'))
    expect(store.getState().agentStatusByPaneKey[FOLDER_PANE]).toBeUndefined()
  })
})

describe('retention rule', () => {
  it('retains for transient statuses and clears for terminal or unknown ones', () => {
    for (const status of CONNECTION_STATUSES_THAT_RETAIN_ROWS) {
      expect(shouldRetainRowsOnConnectionLoss(status)).toBe(true)
    }
    for (const status of [
      'disconnected',
      'auth-failed',
      'reconnection-failed',
      'error',
      undefined
    ] as const) {
      expect(shouldRetainRowsOnConnectionLoss(status)).toBe(false)
    }
  })
})
