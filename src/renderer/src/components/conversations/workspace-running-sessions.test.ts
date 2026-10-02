import { describe, expect, it } from 'vitest'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { HostReachability } from '@/lib/host-reachability'
import { describeRunningSessionLiveness } from './running-session-presentation'
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

const HOSTS = new Map<ExecutionHostId, { label: string; reachability: HostReachability }>([
  ['local', { label: 'This computer', reachability: 'this-machine' }],
  ['ssh:gex44' as ExecutionHostId, { label: 'GEX44', reachability: 'reachable' }],
  ['ssh:unseen' as ExecutionHostId, { label: 'Unseen box', reachability: 'unknown' }],
  ['ssh:refused' as ExecutionHostId, { label: 'Refused box', reachability: 'failed' }]
])

function on(hostId: string): ReturnType<typeof projectRunningSessions>[number] {
  return projectRunningSessions(
    [card({ executionHostId: hostId as ExecutionHostId, bucket: 'working' })],
    HOSTS,
    new Map()
  )[0]
}

describe('running sessions in Workspace', () => {
  it('names the host a session runs on, from the host registry', () => {
    const session = on('ssh:gex44')
    expect(session.hostLabel).toBe('GEX44')
    expect(session.liveness).toBe('working')
  })

  // A host Orca does not observe cannot vouch for its last report of "working".
  it('never reports a session on an unobserved host as working', () => {
    expect(on('ssh:unseen').liveness).toBe('host-unvouched')
  })

  // RED before 2026-10-02: 'disconnected' (no connection open) was rendered "Host offline".
  it('a session on a host Orca never observed is unknown, not host-offline', () => {
    const session = on('ssh:unseen')
    expect(session.liveness).not.toBe('host-offline')
    expect(session.hostReachability).toBe('unknown')
    const shown = describeRunningSessionLiveness(session)
    expect(shown.status).toBe('UNKNOWN')
    expect(shown.label).toBe('Not connected · state unknown')
  })

  // The failure is the host's (drawn on the host); the agent's own state is unobserved.
  it('a failed connection attempt says so in words, and the session mark stays UNKNOWN', () => {
    const shown = describeRunningSessionLiveness(on('ssh:refused'))
    expect(shown.label).toBe('Connection failed')
    expect(shown.status).toBe('UNKNOWN')
  })

  it('a session on a host the registry lost has no reading: unknown', () => {
    const session = on('ssh:gone')
    expect(session.liveness).toBe('host-unvouched')
    expect(session.hostReachability).toBe('unknown')
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
