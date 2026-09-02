/**
 * Three windows, not two.
 *
 * Two windows can pass on a partition that is really just "mine and everyone else's" — a boolean
 * wearing a partition's clothes. The third window is what separates owner-scoped from
 * everything-but-me: when A reloads, B and C must both be untouched, and when B closes, A and C must
 * both survive rather than one of them inheriting B's state.
 *
 * The last case ties the runtime graph to what a relaunch actually restores. A set of three windows
 * that is independent at runtime but collapses to one on restart is not three windows.
 */
import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { RuntimeSyncedLeaf, RuntimeSyncedTab } from '../../shared/runtime-types'
import { OrcaRuntimeService, type RuntimeNotifier } from './orca-runtime'
import { captureWindowTopology, planWindowTopologyRestore } from '../window/window-topology'

const WT = { a: 'repo-1::/tmp/a', b: 'repo-1::/tmp/b', c: 'repo-1::/tmp/c' } as const
const WINDOW = { a: 1, b: 2, c: 3 } as const

const storeBase = {
  getRepo: () => ({
    id: 'repo-1',
    path: '/tmp/repo',
    displayName: 'repo',
    badgeColor: 'blue',
    addedAt: 1
  }),
  getRepos: () => [storeBase.getRepo()],
  addRepo: () => {},
  updateRepo: () => undefined as never,
  getAllWorktreeMeta: () => ({}),
  getWorktreeMeta: () => undefined,
  getGitHubCache: () => ({ pr: {}, issue: {} }),
  setWorktreeMeta: () => undefined as never,
  removeWorktreeMeta: () => {},
  getRetiredWorktreeNameRegistry: () => ({ exhaustedTiers: 0, names: [] }),
  addRetiredWorktreeName: () => {},
  mergeRetiredWorktreeNames: () => false,
  getSettings: () => ({
    workspaceDir: '/tmp/workspaces',
    nestWorkspaces: false,
    refreshLocalBaseRefOnWorktreeCreate: false,
    branchPrefix: 'none',
    branchPrefixCustom: ''
  })
}

type RuntimeInternals = {
  tabs: Map<string, RuntimeSyncedTab>
  leaves: Map<string, { worktreeId: string }>
  handles: Map<string, { worktreeId: string }>
  notifier: RuntimeNotifier | null
  issueHandle(leaf: unknown): string
  getLeafKey(tabId: string, leafId: string): string
  graphOwners: { get(windowId: number): { epoch: number; status: string } | undefined }
}

function makeNotifier(focusTerminal: RuntimeNotifier['focusTerminal']): RuntimeNotifier {
  return {
    worktreesChanged: () => {},
    reposChanged: () => {},
    activateWorktree: () => {},
    createTerminal: () => {},
    splitTerminal: () => {},
    renameTerminal: () => {},
    focusTerminal,
    closeTerminal: () => {},
    sleepWorktree: () => {},
    terminalFitOverrideChanged: () => {},
    terminalDriverChanged: () => {}
  }
}

function makeSession(): WorkspaceSessionState {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: WT.a,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {}
  }
}

/** Three attached windows, each publishing one tab and one leaf for its own worktree. */
function createThreeWindowRuntime() {
  let session = makeSession()
  const runtime = new OrcaRuntimeService({
    ...storeBase,
    getWorkspaceSession: () => session,
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      session = next
    }
  })
  const internals = runtime as unknown as RuntimeInternals
  const focus = { a: vi.fn(), b: vi.fn(), c: vi.fn() }
  for (const key of ['a', 'b', 'c'] as const) {
    const windowId = WINDOW[key]
    const worktreeId = WT[key]
    runtime.attachWindow(windowId)
    const tab: RuntimeSyncedTab = {
      tabId: `tab-${key}`,
      worktreeId,
      title: `Tab ${key}`,
      activeLeafId: null,
      layout: null
    }
    const leaf: RuntimeSyncedLeaf = {
      tabId: `tab-${key}`,
      worktreeId,
      leafId: `leaf-${key}`,
      paneRuntimeId: 1,
      ptyId: null
    }
    runtime.syncWindowGraph(windowId, {
      rendererGeneration: `gen-${key}`,
      tabs: [tab],
      leaves: [leaf],
      mobileSessionTabs: []
    })
    runtime.setNotifier(makeNotifier(focus[key]), windowId)
  }
  return { runtime, internals, focus }
}

function handleFor(internals: RuntimeInternals, key: 'a' | 'b' | 'c'): string {
  const leaf = internals.leaves.get(internals.getLeafKey(`tab-${key}`, `leaf-${key}`))
  if (!leaf) {
    throw new Error(`leaf ${key} is not in the graph`)
  }
  return internals.issueHandle(leaf)
}

describe('three independent workspace windows', () => {
  it('holds all three graphs at once', () => {
    const { internals } = createThreeWindowRuntime()

    expect([...internals.tabs.keys()].sort()).toEqual(['tab-a', 'tab-b', 'tab-c'])
  })

  it('routes a command to the one window that owns the addressed worktree', () => {
    const { internals, focus } = createThreeWindowRuntime()

    internals.notifier?.focusTerminal('tab-b', WT.b, null)

    expect(focus.b.mock.calls).toEqual([['tab-b', WT.b, null]])
    expect(focus.a).not.toHaveBeenCalled()
    expect(focus.c).not.toHaveBeenCalled()
  })

  it('leaves both other windows whole when the middle one closes', () => {
    const { runtime, internals } = createThreeWindowRuntime()
    const handleA = handleFor(internals, 'a')
    const handleC = handleFor(internals, 'c')

    runtime.markGraphUnavailable(WINDOW.b)

    expect(internals.tabs.has('tab-b')).toBe(false)
    // Both, not one: an "everything but me" teardown passes the two-window case and fails here.
    expect(internals.tabs.has('tab-a')).toBe(true)
    expect(internals.tabs.has('tab-c')).toBe(true)
    expect(internals.handles.has(handleA)).toBe(true)
    expect(internals.handles.has(handleC)).toBe(true)
  })

  it('fences only the reloading window, leaving the other two ready', () => {
    const { runtime, internals } = createThreeWindowRuntime()
    const epochB = internals.graphOwners.get(WINDOW.b)?.epoch
    const epochC = internals.graphOwners.get(WINDOW.c)?.epoch

    runtime.markRendererReloading(WINDOW.a)

    expect(internals.graphOwners.get(WINDOW.a)?.status).toBe('reloading')
    expect(internals.graphOwners.get(WINDOW.b)?.status).toBe('ready')
    expect(internals.graphOwners.get(WINDOW.c)?.status).toBe('ready')
    // In-flight work on B and C fences against their own epochs; one shared counter would abort both.
    expect(internals.graphOwners.get(WINDOW.b)?.epoch).toBe(epochB)
    expect(internals.graphOwners.get(WINDOW.c)?.epoch).toBe(epochC)
  })

  it('restores all three windows to their own projects', () => {
    // Runtime independence that collapses to one window on restart is not three windows.
    const captured = captureWindowTopology(
      (['a', 'b', 'c'] as const).map((key, index) => ({
        windowId: `window-${index + 1}`,
        sequence: index + 1,
        binding: { repoId: 'repo-1', worktreeId: WT[key] },
        bounds: { x: index * 40, y: index * 40, width: 1200, height: 800 },
        maximized: false
      }))
    )

    const plan = planWindowTopologyRestore(captured, { worktreeExists: () => true })

    expect(plan.map((entry) => entry.binding?.worktreeId)).toEqual([WT.a, WT.b, WT.c])
    expect(new Set(plan.map((entry) => entry.windowId)).size).toBe(3)
  })
})
