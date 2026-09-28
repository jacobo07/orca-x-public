import { describe, expect, it } from 'vitest'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { ExecutionHostHealth } from '../../../../shared/execution-host-registry'
import { projectRunningSessions } from './workspace-running-sessions'

function card(overrides: Partial<DashboardCard>): DashboardCard {
  return {
    paneKey: 'tab-1:leaf-1',
    ptyId: 'pty-1',
    agentType: 'claude',
    bucket: 'working',
    dotState: 'working',
    task: 'Fix the importer',
    repoId: 'repo-local',
    worktreeId: 'wt-1',
    tabId: 'tab-1',
    leafId: 'leaf-1',
    repoName: 'orca',
    worktreeName: 'main',
    startedAt: 1,
    finishedAt: null,
    stateChangedAt: 10,
    unseen: false,
    ...overrides
  } as DashboardCard
}

const HOSTS = new Map<ExecutionHostId, { label: string; health: ExecutionHostHealth }>([
  ['local', { label: 'This computer', health: 'local' }],
  ['ssh:gex44' as ExecutionHostId, { label: 'GEX44', health: 'available' }],
  ['ssh:down' as ExecutionHostId, { label: 'Down box', health: 'disconnected' }]
])

describe('running sessions in Workspace', () => {
  it('names the host a session runs on, from the host registry', () => {
    const [session] = projectRunningSessions(
      [card({ executionHostId: 'ssh:gex44' as ExecutionHostId })],
      HOSTS,
      new Map()
    )
    expect(session.hostLabel).toBe('GEX44')
    expect(session.liveness).toBe('working')
  })

  // A disconnected host's last report said "working"; repeating it would be a lie about now.
  it('never reports a session on an unreachable host as working', () => {
    const [session] = projectRunningSessions(
      [card({ executionHostId: 'ssh:down' as ExecutionHostId, bucket: 'working' })],
      HOSTS,
      new Map()
    )
    expect(session.liveness).toBe('host-offline')
  })

  it('joins a session to its canonical project through the repo, and leaves folders unjoined', () => {
    const sessions = projectRunningSessions(
      [
        card({ paneKey: 'a', repoId: 'repo-local', stateChangedAt: 5 }),
        card({ paneKey: 'b', repoId: 'folder-workspace:g1', stateChangedAt: 9 })
      ],
      HOSTS,
      new Map([['repo-local', 'github:o/orca']])
    )
    expect(sessions.map((s) => [s.paneKey, s.projectId])).toEqual([
      ['b', null],
      ['a', 'github:o/orca']
    ])
  })

  it('maps attention to needs-you and keeps the pane it would reveal', () => {
    const [session] = projectRunningSessions([card({ bucket: 'attention' })], HOSTS, new Map())
    expect(session.liveness).toBe('needs-you')
    expect(session.reveal).toEqual({
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'leaf-1',
      executionHostId: 'local'
    })
  })
})
