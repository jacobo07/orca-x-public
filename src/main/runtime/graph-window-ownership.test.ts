/**
 * Two project windows each own a runtime graph.
 *
 * The service was written for one: a single authority scalar, a single notifier slot, one reload
 * epoch and one flat set of graph maps. Every `windowId` parameter is checked against the authority
 * and then discarded, so it is an admission credential rather than a partition key. These cases pin
 * the four properties a second window needs, each of which the single-authority model breaks.
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
  leaves: Map<string, unknown>
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

// Skipped deliberately, not quarantined: this is the specification for the per-window runtime
// graph, and it fails 4/4 today for the four reasons named above. Unskip it as the first step of
// that change. It is not skipped because it is flaky or wrong — the behaviour it asks for does not
// exist yet, and the partition it needs (graph maps, handle maps, waiter set, epoch, reload fence
// and notifier, all per owner together) is tracked in docs/workspace-window-mode-plan.md.
describe.skip('runtime graph ownership across windows', () => {
  it('accepts a graph from a second attached window', () => {
    const { runtime } = createRuntime()
    runtime.attachWindow(WINDOW_A)
    publish(runtime, WINDOW_A, 'gen-a', [tab('tab-a', WT_A)], [leaf('tab-a', WT_A, 'leaf-a')])

    runtime.attachWindow(WINDOW_B)

    // Today attachWindow falls off the end for a second real window, so this publish is refused
    // and window B renders with no graph and no terminals.
    expect(() =>
      publish(runtime, WINDOW_B, 'gen-b', [tab('tab-b', WT_B)], [leaf('tab-b', WT_B, 'leaf-b')])
    ).not.toThrow()
  })

  it("does not let one window's graph erase the other window's tabs", () => {
    const { runtime, internals } = createRuntime()
    runtime.attachWindow(WINDOW_A)
    publish(runtime, WINDOW_A, 'gen-a', [tab('tab-a', WT_A)], [leaf('tab-a', WT_A, 'leaf-a')])
    runtime.attachWindow(WINDOW_B)

    try {
      publish(runtime, WINDOW_B, 'gen-b', [tab('tab-b', WT_B)], [leaf('tab-b', WT_B, 'leaf-b')])
    } catch {
      // The publish being refused is the first failure; the erasure is what it hides.
    }

    expect(internals.tabs.has('tab-a')).toBe(true)
    expect(internals.tabs.has('tab-b')).toBe(true)
  })

  it('keeps one window graph alive when the other window closes', () => {
    const { runtime, internals } = createRuntime()
    runtime.attachWindow(WINDOW_A)
    publish(runtime, WINDOW_A, 'gen-a', [tab('tab-a', WT_A)], [leaf('tab-a', WT_A, 'leaf-a')])
    runtime.attachWindow(WINDOW_B)
    try {
      publish(runtime, WINDOW_B, 'gen-b', [tab('tab-b', WT_B)], [leaf('tab-b', WT_B, 'leaf-b')])
    } catch {
      // See above.
    }

    runtime.markGraphUnavailable(WINDOW_A)

    // Closing A clears the one shared graph today, taking B's terminals with it.
    expect(internals.tabs.has('tab-b')).toBe(true)
  })

  it('does not fence the other window when one renderer reloads', () => {
    const { runtime } = createRuntime()
    runtime.attachWindow(WINDOW_A)
    publish(runtime, WINDOW_A, 'gen-a', [tab('tab-a', WT_A)], [leaf('tab-a', WT_A, 'leaf-a')])
    runtime.attachWindow(WINDOW_B)
    try {
      publish(runtime, WINDOW_B, 'gen-b', [tab('tab-b', WT_B)], [leaf('tab-b', WT_B, 'leaf-b')])
    } catch {
      // See above.
    }

    runtime.markRendererReloading(WINDOW_A)

    // B is mid-flight on its own graph; A reloading must not invalidate it.
    expect(runtime.getStatus().graphStatus).not.toBe('reloading')
  })
})
