import { describe, expect, it } from 'vitest'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import {
  deriveRepositoryHostSetupRowState,
  type RepositoryHostSetupRowStateStore
} from './repository-host-setup-row-state'

function setup(overrides: Partial<ProjectHostSetup> = {}): ProjectHostSetup {
  return {
    id: 's1',
    projectId: 'github:acme/widget',
    hostId: 'local',
    repoId: 'r1',
    path: '/srv/widget',
    displayName: 'widget',
    setupState: 'ready',
    setupMethod: 'cloned',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function store(
  overrides: Partial<RepositoryHostSetupRowStateStore> = {}
): RepositoryHostSetupRowStateStore {
  return {
    sshConnectionStates: new Map(),
    sshTargetLabels: new Map(),
    removedSshTargetLabels: new Map(),
    sshTargetsHydrated: true,
    sshStateByEnvironment: new Map(),
    runtimeStatusByEnvironmentId: new Map(),
    ...overrides
  } as RepositoryHostSetupRowStateStore
}

function sshState(status: string): RepositoryHostSetupRowStateStore['sshConnectionStates'] {
  return new Map([['t1', { targetId: 't1', status, error: null, reconnectAttempt: 0 }]]) as never
}

const derive = (rowSetup: ProjectHostSetup, rowStore: RepositoryHostSetupRowStateStore = store()) =>
  deriveRepositoryHostSetupRowState({
    setup: rowSetup,
    hostOptionById: new Map(),
    store: rowStore
  })

describe('deriveRepositoryHostSetupRowState', () => {
  it('reads a ready setup on this computer as ready', () => {
    expect(derive(setup())).toMatchObject({
      health: { state: 'this-host' },
      setupReady: true,
      setupStateLabel: 'Ready'
    })
  })

  it('reads a ready direct SSH setup as Ready only while the connection is connected', () => {
    const ssh = setup({ hostId: 'ssh:t1' })

    expect(derive(ssh, store({ sshConnectionStates: sshState('connected') }))).toMatchObject({
      health: { state: 'reachable' },
      setupReady: true,
      setupStateLabel: 'Ready'
    })
  })

  it('never reads Ready for a direct SSH setup whose connection state is unknown (N4)', () => {
    const row = derive(setup({ hostId: 'ssh:t1' }))

    expect(row.health.state).toBe('unknown')
    expect(row.setupReady).toBe(false)
    expect(row.setupStateLabel).toBe('Unknown')
    expect(row.setupStateLabel).not.toBe('Ready')
  })

  it.each([
    ['disconnected', 'Disconnected'],
    ['auth-failed', 'Disconnected'],
    ['error', 'Disconnected'],
    ['connecting', 'Connecting'],
    ['reconnecting', 'Connecting']
  ])('labels a direct SSH setup whose connection is %s as %s', (status, label) => {
    const row = derive(
      setup({ hostId: 'ssh:t1' }),
      store({ sshConnectionStates: sshState(status) })
    )

    expect(row.setupReady).toBe(false)
    expect(row.setupStateLabel).toBe(label)
  })

  it('keeps the setup own state word for a setup that is not ready on a host of unknown health', () => {
    const row = derive(setup({ hostId: 'ssh:t1', setupState: 'not-set-up' }))

    expect(row.setupStateLabel).toBe('Not set up')
    expect(row.setupReady).toBe(false)
  })

  describe('runtime-owned setups', () => {
    const owned = setup({ hostId: 'runtime:hub', runtimeOwnerEnvironmentId: 'hub' })
    const statusOf = (status: object | null) =>
      store({
        runtimeStatusByEnvironmentId: new Map([['hub', { checkedAt: 1, status }]]) as never
      })

    it('is unreachable and Disconnected when the owner has no status', () => {
      const row = derive(owned, statusOf(null))

      expect(row).toMatchObject({
        health: { state: 'unreachable' },
        setupReady: false,
        setupStateLabel: 'Disconnected'
      })
    })

    it('is reachable and Ready when the owner is reachable and reports a window', () => {
      const row = derive(
        owned,
        statusOf({ graphStatus: 'ready', desktopWindowStatus: 'available' })
      )

      expect(row).toMatchObject({
        health: { state: 'reachable' },
        setupReady: true,
        setupStateLabel: 'Ready',
        runtimeOwnerWorkspaceWindowClosed: false
      })
    })

    it('says the workspace window is closed and is not ready', () => {
      const row = derive(
        owned,
        statusOf({ graphStatus: 'unavailable', desktopWindowStatus: 'openable' })
      )

      expect(row).toMatchObject({
        health: { state: 'unreachable' },
        setupReady: false,
        setupStateLabel: 'Workspace window closed',
        runtimeOwnerWorkspaceWindowClosed: true
      })
    })

    it('is unknown when the owner is reachable but cannot report the nested SSH state', () => {
      const nested = setup({
        hostId: 'runtime:hub',
        executionHostId: 'ssh:jump',
        runtimeOwnerEnvironmentId: 'hub'
      })

      const row = derive(
        nested,
        statusOf({ graphStatus: 'ready', desktopWindowStatus: 'available' })
      )

      expect(row).toMatchObject({
        health: { state: 'unknown' },
        setupReady: false,
        setupStateLabel: 'Unknown'
      })
    })
  })
})
