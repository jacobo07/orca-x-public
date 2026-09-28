import { describe, expect, it } from 'vitest'
import { readDesk, type DeskReadStore } from './desk-read'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { ExecutionHostId } from '../../shared/execution-host'

const SEP = '::'

function state(tabsByWorktree: WorkspaceSessionState['tabsByWorktree']): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree,
    terminalLayoutsByTabId: {}
  }
}

const tab = (id: string, ptyId: string | null = null) => ({
  id,
  ptyId,
  worktreeId: 'w',
  title: id,
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 0
})

function store(overrides: Partial<DeskReadStore> = {}): DeskReadStore {
  return {
    getWorkspaceSessionHostIds: () => ['local'] as ExecutionHostId[],
    getWorkspaceSession: () => state({ [`repo1${SEP}/src/app`]: [tab('t1', 'p1')] }),
    getUI: () => ({ windowTopology: [] }),
    getRepo: (id) =>
      id === 'repo1'
        ? ({ id, path: '/src/app', displayName: 'App', badgeColor: '' } as never)
        : undefined,
    getFolderWorkspace: () => undefined,
    ...overrides
  }
}

const deps = (s: DeskReadStore, list: () => Promise<string[]>) => ({
  store: s,
  listLocalSessionIds: list,
  now: () => 1000
})

describe('readDesk', () => {
  it('observes local liveness and names the workspace from the repo', async () => {
    const result = await readDesk(deps(store(), async () => ['p1']))
    expect(result.status).toBe('loaded')
    if (result.status !== 'loaded') {
      return
    }
    const host = result.projection.hosts[0]
    const workspace = host?.kind === 'loaded' ? host.workspaces[0] : undefined
    expect(workspace?.kind === 'projected' ? workspace.identity : null).toEqual({
      kind: 'known',
      name: 'App',
      path: '/src/app'
    })
    expect(result.projection.totals.byResidency.warm).toBe(1)
    expect(result.readAt).toBe(1000)
  })

  it('reports unknown residency when the local listing fails, never stopped', async () => {
    const result = await readDesk(
      deps(store(), async () => {
        throw new Error('daemon down')
      })
    )
    expect(result.status === 'loaded' && result.projection.totals.byResidency).toEqual({
      warm: 0,
      dormant: 0,
      'no-process': 0,
      unknown: 1
    })
  })

  it('never asks a remote host, and keeps its partition readable', async () => {
    const s = store({ getWorkspaceSessionHostIds: () => ['local', 'ssh:box'] as ExecutionHostId[] })
    const result = await readDesk(deps(s, async () => ['p1']))
    if (result.status !== 'loaded') {
      throw new Error('expected loaded')
    }
    const remote = result.projection.hosts[1]
    const remoteTab =
      remote?.kind === 'loaded' && remote.workspaces[0]?.kind === 'projected'
        ? remote.workspaces[0].tabs[0]
        : undefined
    expect(remoteTab?.residency).toBe('unknown')
  })

  it('isolates an unreadable partition and an unreadable window list', async () => {
    const s = store({
      getWorkspaceSessionHostIds: () => ['local', 'ssh:box'] as ExecutionHostId[],
      getWorkspaceSession: (hostId) => {
        if (hostId === 'ssh:box') {
          throw new Error('corrupt partition')
        }
        return state({ [`repo1${SEP}/src/app`]: [tab('t1')] })
      },
      getUI: () => {
        throw new Error('ui unreadable')
      }
    })
    const result = await readDesk(deps(s, async () => []))
    if (result.status !== 'loaded') {
      throw new Error('expected loaded')
    }
    expect(result.projection.windowsRecorded).toBe(false)
    expect(result.projection.hosts.map((h) => h.kind)).toEqual(['loaded', 'unreadable'])
  })

  it('says missing for a removed repo or folder and unknown for an unparsable key', async () => {
    const s = store({
      getWorkspaceSession: () =>
        state({
          [`gone${SEP}/x`]: [tab('a')],
          'folder:f1': [tab('b')],
          'not-a-worktree-id': [tab('c')]
        })
    })
    const result = await readDesk(deps(s, async () => []))
    if (result.status !== 'loaded') {
      throw new Error('expected loaded')
    }
    const host = result.projection.hosts[0]
    const identities = Object.fromEntries(
      (host?.kind === 'loaded' ? host.workspaces : []).map((w) => [
        w.key,
        w.kind === 'projected' ? w.identity.kind : null
      ])
    )
    expect(identities).toEqual({
      [`gone${SEP}/x`]: 'missing',
      'folder:f1': 'missing',
      'not-a-worktree-id': 'unknown'
    })
  })
})
