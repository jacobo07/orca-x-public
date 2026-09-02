/**
 * Two project windows each own a runtime graph.
 *
 * The service was written for one: a single authority scalar, one reload epoch, one active fence and
 * one flat set of graph maps that a publish replaced wholesale. Every `windowId` parameter was
 * checked against the authority and then discarded, making it an admission credential rather than a
 * partition key.
 *
 * The last three cases are the ones worth keeping honest. Partitioning only what the UI can see —
 * tabs and leaves — while handles, waiters and the epoch stayed global would satisfy the first four
 * and still let one window's reload strip another window's live terminals, which is a silent loss of
 * running work rather than a visible failure.
 */
import { describe, expect, it } from 'vitest'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { RuntimeSyncedLeaf, RuntimeSyncedTab } from '../../shared/runtime-types'
import { OrcaRuntimeService } from './orca-runtime'

const WT_A = 'repo-1::/tmp/worktree-a'
const WT_B = 'repo-1::/tmp/worktree-b'
const WINDOW_A = 1
const WINDOW_B = 2

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

function makeSession(): WorkspaceSessionState {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: WT_A,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {}
  }
}

type RuntimeInternals = {
  tabs: Map<string, RuntimeSyncedTab>
  leaves: Map<string, { worktreeId: string }>
  handles: Map<string, { worktreeId: string }>
  waitersByHandle: Map<string, Set<unknown>>
  issueHandle(leaf: unknown): string
  getLeafKey(tabId: string, leafId: string): string
  graphOwners: { get(windowId: number): { epoch: number; status: string } | undefined }
}

/** Mint a terminal handle for a published leaf — the hidden state a half-partition would destroy. */
function handleFor(internals: RuntimeInternals, tabId: string, leafId: string): string {
  const leaf = internals.leaves.get(internals.getLeafKey(tabId, leafId))
  if (!leaf) {
    throw new Error(`leaf ${tabId}/${leafId} is not in the graph`)
  }
  return internals.issueHandle(leaf)
}

function createRuntime() {
  let session = makeSession()
  const runtime = new OrcaRuntimeService({
    ...storeBase,
    getWorkspaceSession: () => session,
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      session = next
    }
  })
  return { runtime, internals: runtime as unknown as RuntimeInternals }
}

function tab(tabId: string, worktreeId: string): RuntimeSyncedTab {
  return { tabId, worktreeId, title: `Tab ${tabId}`, activeLeafId: null, layout: null }
}

function leaf(tabId: string, worktreeId: string, leafId: string): RuntimeSyncedLeaf {
  return { tabId, worktreeId, leafId, paneRuntimeId: 1, ptyId: null }
}

function publish(
  runtime: OrcaRuntimeService,
  windowId: number,
  generation: string,
  tabs: RuntimeSyncedTab[],
  leaves: RuntimeSyncedLeaf[]
) {
  return runtime.syncWindowGraph(windowId, {
    rendererGeneration: generation,
    tabs,
    leaves,
    mobileSessionTabs: []
  })
}

describe('runtime graph ownership across windows', () => {
  it('accepts a graph from a second attached window', () => {
    const { runtime } = createRuntime()
    runtime.attachWindow(WINDOW_A)
    publish(runtime, WINDOW_A, 'gen-a', [tab('tab-a', WT_A)], [leaf('tab-a', WT_A, 'leaf-a')])

    runtime.attachWindow(WINDOW_B)

    // attachWindow used to fall off the end for a second real window, so this publish was refused
    // and window B rendered with no graph and no terminals.
    expect(() =>
      publish(runtime, WINDOW_B, 'gen-b', [tab('tab-b', WT_B)], [leaf('tab-b', WT_B, 'leaf-b')])
    ).not.toThrow()
  })

  it("does not let one window's graph erase the other window's tabs", () => {
    const { runtime, internals } = createRuntime()
    runtime.attachWindow(WINDOW_A)
    publish(runtime, WINDOW_A, 'gen-a', [tab('tab-a', WT_A)], [leaf('tab-a', WT_A, 'leaf-a')])
    runtime.attachWindow(WINDOW_B)

    publish(runtime, WINDOW_B, 'gen-b', [tab('tab-b', WT_B)], [leaf('tab-b', WT_B, 'leaf-b')])

    expect(internals.tabs.has('tab-a')).toBe(true)
    expect(internals.tabs.has('tab-b')).toBe(true)
  })

  it('keeps one window graph alive when the other window closes', () => {
    const { runtime, internals } = createRuntime()
    runtime.attachWindow(WINDOW_A)
    publish(runtime, WINDOW_A, 'gen-a', [tab('tab-a', WT_A)], [leaf('tab-a', WT_A, 'leaf-a')])
    runtime.attachWindow(WINDOW_B)
    publish(runtime, WINDOW_B, 'gen-b', [tab('tab-b', WT_B)], [leaf('tab-b', WT_B, 'leaf-b')])

    runtime.markGraphUnavailable(WINDOW_A)

    // Closing A used to clear the one shared graph, taking B's terminals with it.
    expect(internals.tabs.has('tab-b')).toBe(true)
  })

  it('does not fence the other window when one renderer reloads', () => {
    const { runtime } = createRuntime()
    runtime.attachWindow(WINDOW_A)
    publish(runtime, WINDOW_A, 'gen-a', [tab('tab-a', WT_A)], [leaf('tab-a', WT_A, 'leaf-a')])
    runtime.attachWindow(WINDOW_B)
    publish(runtime, WINDOW_B, 'gen-b', [tab('tab-b', WT_B)], [leaf('tab-b', WT_B, 'leaf-b')])

    runtime.markRendererReloading(WINDOW_A)

    // B is mid-flight on its own graph; A reloading must not invalidate it.
    expect(runtime.getStatus().graphStatus).not.toBe('reloading')
  })

  it("keeps the other window's terminal handles when one renderer reloads", () => {
    const { runtime, internals } = createRuntime()
    runtime.attachWindow(WINDOW_A)
    publish(runtime, WINDOW_A, 'gen-a', [tab('tab-a', WT_A)], [leaf('tab-a', WT_A, 'leaf-a')])
    runtime.attachWindow(WINDOW_B)
    publish(runtime, WINDOW_B, 'gen-b', [tab('tab-b', WT_B)], [leaf('tab-b', WT_B, 'leaf-b')])
    const handleA = handleFor(internals, 'tab-a', 'leaf-a')
    const handleB = handleFor(internals, 'tab-b', 'leaf-b')

    runtime.markRendererReloading(WINDOW_A)

    // The reload clears the reloading window's handles — and only those. Clearing the map wholesale
    // is what silently took the other window's live terminals with it.
    expect(internals.handles.has(handleA)).toBe(false)
    expect(internals.handles.has(handleB)).toBe(true)
  })

  it("keeps the other window's terminal handles when one window closes", () => {
    const { runtime, internals } = createRuntime()
    runtime.attachWindow(WINDOW_A)
    publish(runtime, WINDOW_A, 'gen-a', [tab('tab-a', WT_A)], [leaf('tab-a', WT_A, 'leaf-a')])
    runtime.attachWindow(WINDOW_B)
    publish(runtime, WINDOW_B, 'gen-b', [tab('tab-b', WT_B)], [leaf('tab-b', WT_B, 'leaf-b')])
    const handleB = handleFor(internals, 'tab-b', 'leaf-b')

    runtime.markGraphUnavailable(WINDOW_A)

    expect(internals.handles.has(handleB)).toBe(true)
    expect(internals.leaves.has(internals.getLeafKey('tab-b', 'leaf-b'))).toBe(true)
  })

  it("does not advance the other window's graph epoch when one renderer reloads", () => {
    const { runtime, internals } = createRuntime()
    runtime.attachWindow(WINDOW_A)
    publish(runtime, WINDOW_A, 'gen-a', [tab('tab-a', WT_A)], [leaf('tab-a', WT_A, 'leaf-a')])
    runtime.attachWindow(WINDOW_B)
    publish(runtime, WINDOW_B, 'gen-b', [tab('tab-b', WT_B)], [leaf('tab-b', WT_B, 'leaf-b')])
    const epochBefore = internals.graphOwners.get(WINDOW_B)?.epoch

    runtime.markRendererReloading(WINDOW_A)

    // An in-flight operation on B fences against B's epoch; one shared counter would fail it here.
    expect(internals.graphOwners.get(WINDOW_B)?.epoch).toBe(epochBefore)
    expect(internals.graphOwners.get(WINDOW_B)?.status).toBe('ready')
    expect(internals.graphOwners.get(WINDOW_A)?.status).toBe('reloading')
  })
})
