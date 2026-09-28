import { describe, expect, it } from 'vitest'
import {
  projectDesk,
  type DeskHostInput,
  type DeskProjectionInput
} from './desk-continuity-projection'
import type { WorkspaceSessionState } from './workspace-session-state-types'
import type { TerminalTab } from './terminal-tab-types'

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'

function tab(id: string, worktreeId: string, extra: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId,
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...extra
  }
}

function session(extra: Partial<WorkspaceSessionState>): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    ...extra
  }
}

function localHost(state: WorkspaceSessionState, live: string[] | null = []): DeskHostInput {
  return {
    hostId: 'local',
    session: { kind: 'loaded', state },
    liveness: live
      ? { kind: 'observed', liveSessionIds: new Set(live) }
      : { kind: 'unknown', reason: 'not-asked' }
  }
}

function input(
  hosts: DeskHostInput[],
  extra: Partial<DeskProjectionInput> = {}
): DeskProjectionInput {
  return {
    hosts,
    windows: [],
    describeWorkspace: () => ({ kind: 'known', name: 'repo', path: '/repo' }),
    ...extra
  }
}

function onlyTabs(result: ReturnType<typeof projectDesk>) {
  const host = result.hosts[0]
  if (host?.kind !== 'loaded') {
    throw new Error('expected a loaded host')
  }
  return host.workspaces.flatMap((workspace) =>
    workspace.kind === 'projected' ? workspace.tabs : []
  )
}

describe('projectDesk residency', () => {
  it('is warm only when an observed live session id matches the row', () => {
    const state = session({ tabsByWorktree: { wt1: [tab('t1', 'wt1', { ptyId: 'p1' })] } })
    expect(onlyTabs(projectDesk(input([localHost(state, ['p1'])])))[0]?.residency).toBe('warm')
    expect(onlyTabs(projectDesk(input([localHost(state, ['other'])])))[0]?.residency).toBe(
      'no-process'
    )
  })

  it('says unknown, not stopped, when liveness could not be observed', () => {
    const state = session({ tabsByWorktree: { wt1: [tab('t1', 'wt1', { ptyId: 'p1' })] } })
    expect(onlyTabs(projectDesk(input([localHost(state, null)])))[0]?.residency).toBe('unknown')
  })

  it('reads dormancy from the marker, and a live process still outranks it', () => {
    const dormant = tab('t1', 'wt1', {
      ptyId: 'p1',
      dormancy: { reason: 'workspace-sleep', resumeContinuity: 'exact' }
    })
    const state = session({ tabsByWorktree: { wt1: [dormant] } })
    expect(onlyTabs(projectDesk(input([localHost(state, [])])))[0]?.residency).toBe('dormant')
    expect(onlyTabs(projectDesk(input([localHost(state, ['p1'])])))[0]?.residency).toBe('warm')
  })

  it('counts a relay session and a split pane session as the row being warm', () => {
    const state = session({
      tabsByWorktree: { wt1: [tab('t1', 'wt1'), tab('t2', 'wt1', { sortOrder: 1 })] },
      remoteSessionIdsByTabId: { t1: 'relay-1' },
      terminalLayoutsByTabId: {
        t2: {
          root: { type: 'leaf', leafId: LEAF_A },
          activeLeafId: LEAF_A,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_A]: 'leaf-pty' }
        }
      }
    })
    const tabs = onlyTabs(projectDesk(input([localHost(state, ['relay-1', 'leaf-pty'])])))
    expect(tabs.map((t) => t.residency)).toEqual(['warm', 'warm'])
  })
})

describe('projectDesk resume verdict', () => {
  it('carries the recorded verdict and never upgrades an unjudged handle to exact', () => {
    const judged = tab('t1', 'wt1', {
      dormancy: { reason: 'working-set-restore', resumeContinuity: 'exact' }
    })
    const unjudged = tab('t2', 'wt1', { sortOrder: 1, dormancy: { reason: 'workspace-sleep' } })
    const plain = tab('t3', 'wt1', { sortOrder: 2 })
    const state = session({
      tabsByWorktree: { wt1: [judged, unjudged, plain] },
      sleepingAgentSessionsByPaneKey: {
        [`t2:${LEAF_A}`]: {} as never
      }
    })
    const tabs = onlyTabs(projectDesk(input([localHost(state)])))
    expect(tabs.map((t) => t.resume)).toEqual(['exact', 'unconfirmed', 'none'])
  })
})

describe('projectDesk window membership', () => {
  const state = session({
    tabsByWorktree: {
      wt1: [tab('t1', 'wt1')],
      'worktree:wt2': [tab('t2', 'wt2')],
      wt3: [tab('t3', 'wt3')],
      'folder:f1': [tab('t4', 'f1')]
    }
  })

  it('binds by worktree id in either key spelling, and says why the rest are unattributed', () => {
    const result = projectDesk(
      input([localHost(state)], {
        windows: [
          {
            windowId: 'w-a',
            sequence: 1,
            binding: { repoId: 'r', worktreeId: 'wt1' },
            bounds: null,
            maximized: false
          },
          {
            windowId: 'w-b',
            sequence: 2,
            binding: { repoId: 'r', worktreeId: 'wt2' },
            bounds: null,
            maximized: false
          }
        ]
      })
    )
    const host = result.hosts[0]
    if (host?.kind !== 'loaded') {
      throw new Error('expected loaded')
    }
    const byKey = Object.fromEntries(
      host.workspaces.map((w) => [w.key, w.kind === 'projected' ? w.window : null])
    )
    expect(byKey.wt1).toEqual({ kind: 'bound', windowId: 'w-a', sequence: 1 })
    expect(byKey['worktree:wt2']).toEqual({ kind: 'bound', windowId: 'w-b', sequence: 2 })
    expect(byKey.wt3).toEqual({ kind: 'unattributed', reason: 'no-window-binding' })
    expect(byKey['folder:f1']).toEqual({ kind: 'unattributed', reason: 'folder-workspace' })
    // Bound windows first, in window order.
    expect(host.workspaces.slice(0, 2).map((w) => w.key)).toEqual(['wt1', 'worktree:wt2'])
  })

  it('does not call an unrecorded window list "no windows"', () => {
    const result = projectDesk(input([localHost(state)], { windows: null }))
    expect(result.windowsRecorded).toBe(false)
    const host = result.hosts[0]
    const first = host?.kind === 'loaded' ? host.workspaces.find((w) => w.key === 'wt1') : undefined
    expect(first?.kind === 'projected' ? first.window : null).toEqual({
      kind: 'unattributed',
      reason: 'windows-unrecorded'
    })
  })
})

describe('projectDesk identity and isolation', () => {
  it('keeps two tabs with the same title as two rows', () => {
    const state = session({
      tabsByWorktree: {
        wt1: [
          tab('a', 'wt1', { title: 'claude' }),
          tab('b', 'wt1', { title: 'claude', sortOrder: 1 })
        ]
      }
    })
    expect(onlyTabs(projectDesk(input([localHost(state)]))).map((t) => t.tabId)).toEqual(['a', 'b'])
  })

  it('isolates an unreadable host and a workspace that cannot be projected', () => {
    const good = session({ tabsByWorktree: { ok: [tab('t1', 'ok')], bad: [tab('t2', 'bad')] } })
    const result = projectDesk(
      input(
        [
          localHost(good),
          {
            hostId: 'ssh:box',
            session: { kind: 'unreadable', reason: 'parse' },
            liveness: { kind: 'unknown', reason: 'host-unreachable' }
          }
        ],
        {
          describeWorkspace: (key) => {
            if (key === 'bad') {
              throw new Error('corrupt identity')
            }
            return { kind: 'known', name: key, path: null }
          }
        }
      )
    )
    const local = result.hosts[0]
    expect(local?.kind === 'loaded' ? local.workspaces.map((w) => w.kind) : []).toEqual([
      'projected',
      'unprojectable'
    ])
    expect(result.hosts[1]).toEqual({ kind: 'unreadable', hostId: 'ssh:box', reason: 'parse' })
  })
})

describe('projectDesk panes and previews', () => {
  it('lists split panes in layout order with the source each preview would read', () => {
    const state = session({
      tabsByWorktree: { wt1: [tab('t1', 'wt1')] },
      terminalLayoutsByTabId: {
        t1: {
          root: {
            type: 'split',
            direction: 'vertical',
            first: { type: 'leaf', leafId: LEAF_A },
            second: { type: 'leaf', leafId: LEAF_B }
          },
          activeLeafId: LEAF_A,
          expandedLeafId: null,
          scrollbackRefsByLeafId: { [LEAF_A]: 'v1-0123456789abcdef0123456789abcdef' },
          ptyIdsByLeafId: { [LEAF_B]: 'pty-b' },
          titlesByLeafId: { [LEAF_B]: 'build' }
        }
      }
    })
    const [only] = onlyTabs(projectDesk(input([localHost(state)])))
    expect(only?.panes).toEqual([
      {
        leafId: LEAF_A,
        title: null,
        preview: { source: 'session-ref', ref: 'v1-0123456789abcdef0123456789abcdef' }
      },
      { leafId: LEAF_B, title: 'build', preview: { source: 'daemon-history', sessionId: 'pty-b' } }
    ])
  })

  it('never offers the local daemon history for a remote host', () => {
    const state = session({ tabsByWorktree: { wt1: [tab('t1', 'wt1', { ptyId: 'remote-pty' })] } })
    const result = projectDesk(input([{ ...localHost(state), hostId: 'ssh:box' }]))
    expect(onlyTabs(result)[0]?.panes[0]?.preview).toEqual({ source: 'none' })
  })

  it('totals rows by residency', () => {
    const state = session({
      tabsByWorktree: {
        wt1: [
          tab('t1', 'wt1', { ptyId: 'p1' }),
          tab('t2', 'wt1', { sortOrder: 1, dormancy: { reason: 'workspace-sleep' } })
        ]
      }
    })
    expect(projectDesk(input([localHost(state, ['p1'])])).totals).toEqual({
      workspaces: 1,
      tabs: 2,
      panes: 2,
      byResidency: { warm: 1, dormant: 1, 'no-process': 0, unknown: 0 }
    })
  })
})

function record(paneKey: string, worktreeId: string, capturedAt: number, tabId?: string) {
  return {
    paneKey,
    ...(tabId ? { tabId } : {}),
    worktreeId,
    agent: 'codex',
    providerSession: { key: 'session_id', id: `s-${paneKey}` },
    prompt: '',
    state: 'working',
    capturedAt,
    updatedAt: capturedAt
  } as never
}

function onlyWorkspaces(result: ReturnType<typeof projectDesk>) {
  const host = result.hosts[0]
  if (host?.kind !== 'loaded') {
    throw new Error('expected a loaded host')
  }
  return host.workspaces.flatMap((workspace) => (workspace.kind === 'projected' ? [workspace] : []))
}

describe('projectDesk orphan sessions', () => {
  it('lists a resumable record whose tab is gone, beside the rows that remain', () => {
    const state = session({
      tabsByWorktree: { wt1: [tab('t1', 'wt1')] },
      sleepingAgentSessionsByPaneKey: {
        [`gone:${LEAF_A}`]: record(`gone:${LEAF_A}`, 'wt1', 20, 'gone'),
        [`t1:${LEAF_B}`]: record(`t1:${LEAF_B}`, 'wt1', 10, 't1')
      }
    })
    const [workspace] = onlyWorkspaces(projectDesk(input([localHost(state)])))
    expect(workspace?.orphanSessions).toEqual([
      { paneKey: `gone:${LEAF_A}`, agent: 'codex', capturedAt: 20, resume: 'unconfirmed' }
    ])
    expect(workspace?.tabs.map((row) => row.tabId)).toEqual(['t1'])
  })

  it('keeps a workspace whose only trace is an orphaned agent', () => {
    const state = session({
      tabsByWorktree: { wt1: [] },
      sleepingAgentSessionsByPaneKey: {
        [`gone:${LEAF_A}`]: record(`gone:${LEAF_A}`, 'wt1', 5, 'gone')
      }
    })
    const workspaces = onlyWorkspaces(projectDesk(input([localHost(state)])))
    expect(workspaces.map((w) => [w.key, w.tabs.length, w.orphanSessions.length])).toEqual([
      ['wt1', 0, 1]
    ])
  })

  it('does not call a record orphaned while its tab still exists', () => {
    const state = session({
      tabsByWorktree: { wt1: [tab('t1', 'wt1')] },
      sleepingAgentSessionsByPaneKey: { [`t1:${LEAF_A}`]: record(`t1:${LEAF_A}`, 'wt1', 1) }
    })
    expect(onlyWorkspaces(projectDesk(input([localHost(state)])))[0]?.orphanSessions).toEqual([])
  })
})
