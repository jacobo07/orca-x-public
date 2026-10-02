import { describe, expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { WorkspaceRunningSession } from '../conversations/workspace-running-sessions'
import type { SidebarHostOption } from '../sidebar/sidebar-host-options'
import { buildWorkstation, deriveReachability } from './workstation-projection'

const SSH = 'ssh:box' as ExecutionHostId
const RUNTIME = 'runtime:env' as ExecutionHostId
const GONE = 'ssh:gone' as ExecutionHostId

function host(
  overrides: Partial<SidebarHostOption> & Pick<SidebarHostOption, 'id'>
): SidebarHostOption {
  return {
    label: overrides.id,
    detail: '',
    kind: 'ssh',
    health: 'disconnected',
    presence: 'configured',
    ...overrides
  }
}

const local = host({
  id: LOCAL_EXECUTION_HOST_ID,
  kind: 'local',
  health: 'local',
  label: 'This PC'
})

function setup(
  overrides: Partial<ProjectHostSetup> & Pick<ProjectHostSetup, 'id' | 'hostId'>
): ProjectHostSetup {
  return {
    projectId: 'p1',
    repoId: `repo-${overrides.id}`,
    path: `/src/${overrides.id}`,
    displayName: `folder-${overrides.id}`,
    setupState: 'ready',
    setupMethod: 'cloned',
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

function session(
  overrides: Partial<WorkspaceRunningSession> & Pick<WorkspaceRunningSession, 'paneKey' | 'hostId'>
): WorkspaceRunningSession {
  return {
    agentType: 'claude',
    title: overrides.paneKey,
    liveness: 'working',
    hostLabel: overrides.hostId,
    projectId: 'p1',
    worktreeName: 'main',
    lastChangedAt: 0,
    reveal: { worktreeId: 'w', tabId: 't', leafId: null, executionHostId: overrides.hostId },
    ...overrides
  } as WorkspaceRunningSession
}

describe('deriveReachability (spec §2)', () => {
  it.each([
    ['local is this machine', { kind: 'local', health: 'local' }, 'this-machine'],
    [
      'ssh connected is reachable',
      { kind: 'ssh', health: 'available', connectionStatus: 'connected' },
      'reachable'
    ],
    ['ssh never observed is unknown', { kind: 'ssh', health: 'disconnected' }, 'unknown'],
    [
      'ssh disconnected is unknown, not down',
      { kind: 'ssh', health: 'disconnected', connectionStatus: 'disconnected' },
      'unknown'
    ],
    [
      'ssh connecting',
      { kind: 'ssh', health: 'connecting', connectionStatus: 'deploying-relay' },
      'connecting'
    ],
    [
      'ssh auth failed',
      { kind: 'ssh', health: 'error', connectionStatus: 'auth-failed' },
      'failed'
    ],
    [
      'ssh reconnection failed',
      { kind: 'ssh', health: 'error', connectionStatus: 'reconnection-failed' },
      'failed'
    ],
    ['runtime with a live status', { kind: 'runtime', health: 'available' }, 'reachable'],
    ['runtime never probed is unknown', { kind: 'runtime', health: 'disconnected' }, 'unknown'],
    ['runtime error', { kind: 'runtime', health: 'error' }, 'failed'],
    ['runtime version skew', { kind: 'runtime', health: 'blocked' }, 'blocked']
  ] as const)('%s', (_name, input, expected) => {
    expect(deriveReachability(input)).toBe(expected)
  })

  it('reads the observation, not the health: connected with stale health is still reachable only by status', () => {
    // Control pair differing only in connectionStatus.
    expect(
      deriveReachability({ kind: 'ssh', health: 'available', connectionStatus: 'connected' })
    ).toBe('reachable')
    expect(deriveReachability({ kind: 'ssh', health: 'available' })).toBe('unknown')
  })
})

describe('buildWorkstation', () => {
  it('groups projects and agents under their host, this machine first', () => {
    const { nodes } = buildWorkstation({
      hosts: [
        host({ id: SSH, label: 'box', health: 'available', connectionStatus: 'connected' }),
        local
      ],
      setups: [
        setup({ id: 's1', hostId: LOCAL_EXECUTION_HOST_ID }),
        setup({ id: 's2', hostId: SSH })
      ],
      projects: [{ id: 'p1', displayName: 'Orca' }],
      sessions: [session({ paneKey: 'a', hostId: SSH })]
    })
    expect(nodes.map((node) => node.hostId)).toEqual([LOCAL_EXECUTION_HOST_ID, SSH])
    expect(nodes[0].projects.map((p) => [p.name, p.path])).toEqual([['Orca', '/src/s1']])
    expect(nodes[1].agents).toEqual([
      { paneKey: 'a', title: 'a', projectName: 'Orca', state: 'working' }
    ])
  })

  it('an agent on a host Orca cannot see reads unknown, not its last state and not offline', () => {
    const seen = buildWorkstation({
      hosts: [local, host({ id: SSH, health: 'available', connectionStatus: 'connected' })],
      setups: [],
      projects: [],
      sessions: [session({ paneKey: 'a', hostId: SSH, liveness: 'needs-you' })]
    })
    const unseen = buildWorkstation({
      hosts: [local, host({ id: SSH })],
      setups: [],
      projects: [],
      sessions: [session({ paneKey: 'a', hostId: SSH, liveness: 'host-offline' })]
    })
    expect(seen.nodes[1].agents[0].state).toBe('needs-you')
    expect(unseen.nodes[1].agents[0].state).toBe('unknown')
  })

  it('keeps a setup or agent whose host the registry does not know, on its own unknown card', () => {
    const { nodes, summary } = buildWorkstation({
      hosts: [local],
      setups: [setup({ id: 's1', hostId: GONE })],
      projects: [],
      sessions: [session({ paneKey: 'a', hostId: GONE })]
    })
    const orphan = nodes.find((node) => node.hostId === GONE)
    expect(orphan).toMatchObject({ host: null, label: GONE, reachability: 'unknown' })
    expect(orphan?.projects).toHaveLength(1)
    expect(orphan?.agents).toHaveLength(1)
    expect(nodes.at(-1)?.hostId).toBe(GONE)
    expect(summary.byReachability.unknown).toBe(1)
  })

  it('names why an attempt failed and which side a version block is on', () => {
    const { nodes } = buildWorkstation({
      hosts: [
        local,
        host({ id: SSH, label: 'a', health: 'error', connectionStatus: 'auth-failed' }),
        host({
          id: RUNTIME,
          label: 'b',
          kind: 'runtime',
          health: 'blocked',
          compatibility: {
            kind: 'blocked',
            reason: 'server-too-old'
          } as SidebarHostOption['compatibility']
        })
      ],
      setups: [],
      projects: [],
      sessions: []
    })
    expect(nodes[1]).toMatchObject({ reachability: 'failed', failure: 'auth-failed' })
    expect(nodes[2]).toMatchObject({
      reachability: 'blocked',
      blocked: 'server-too-old',
      failure: null
    })
  })

  it('summary counts are the cards’ counts; only finished setups count as set up', () => {
    const { nodes, summary } = buildWorkstation({
      hosts: [
        local,
        host({ id: SSH }),
        host({ id: RUNTIME, kind: 'runtime', health: 'available' })
      ],
      setups: [
        setup({ id: 's1', hostId: LOCAL_EXECUTION_HOST_ID }),
        setup({ id: 's2', hostId: SSH, setupState: 'setting-up' }),
        setup({ id: 's3', hostId: RUNTIME, setupState: 'error' })
      ],
      projects: [],
      sessions: [
        session({ paneKey: 'a', hostId: LOCAL_EXECUTION_HOST_ID }),
        session({ paneKey: 'b', hostId: SSH })
      ]
    })
    expect(summary.hosts).toBe(nodes.length)
    expect(summary.byReachability).toEqual({
      'this-machine': 1,
      reachable: 1,
      connecting: 0,
      failed: 0,
      blocked: 0,
      unknown: 1
    })
    expect(summary.projectsSetUp).toBe(1)
    expect(summary.agents).toBe(nodes.reduce((sum, node) => sum + node.agents.length, 0))
    expect(summary.agents).toBe(2)
  })
})
