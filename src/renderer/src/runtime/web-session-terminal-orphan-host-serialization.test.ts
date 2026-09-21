import { beforeEach, describe, expect, it } from 'vitest'
import { toRemoteRuntimePtyId } from './runtime-terminal-stream'
import {
  clearWebSessionTerminalOrphanRecoveryForTests,
  recoverWebSessionTerminalOrphansBeforeApply
} from './web-session-terminal-orphan-recovery'
import { resetRuntimeHostQueueForTests } from './runtime-host-query-queue'

// Why: the host refreshes its PTY inventory under one generation counter per runtime
// (orca-runtime.ts refreshPtyWorktreeRecordsWithControllerInventory), so a fresh listing
// that is overlapped by a later one is failed closed — pinned by
// src/main/runtime/terminal-list-fresh-liveness-overlap.test.ts against the real service.
// Orphan recovery single-flights per (environment, worktree), which is narrower than that
// contract, and web-session-tabs-sync fans it across every worktree of a host at once.

const ENVIRONMENT_ID = 'windows-2'

type Worktree = { id: string; tabId: string; hostTabId: string; handle: string }

const WORKTREE_A: Worktree = {
  id: 'repo::C:\\wt-a',
  tabId: 'web-terminal-host-tab-a',
  hostTabId: 'host-tab-a',
  handle: 'term_live_a'
}
const WORKTREE_B: Worktree = {
  id: 'repo::C:\\wt-b',
  tabId: 'web-terminal-host-tab-b',
  hostTabId: 'host-tab-b',
  handle: 'term_live_b'
}

function makeState(worktrees: Worktree[], environmentId = ENVIRONMENT_ID) {
  return {
    tabsByWorktree: Object.fromEntries(
      worktrees.map((wt) => [wt.id, [{ id: wt.tabId, worktreeId: wt.id } as never]])
    ),
    terminalLayoutsByTabId: Object.fromEntries(
      worktrees.map((wt) => [
        wt.tabId,
        {
          root: { type: 'leaf' as const, leafId: 'leaf-1' },
          activeLeafId: 'leaf-1',
          expandedLeafId: null,
          ptyIdsByLeafId: { 'leaf-1': toRemoteRuntimePtyId(wt.handle, environmentId) }
        }
      ])
    ),
    activeTabIdByWorktree: Object.fromEntries(worktrees.map((wt) => [wt.id, wt.tabId])),
    activeGroupIdByWorktree: Object.fromEntries(worktrees.map((wt) => [wt.id, 'group-1'])),
    groupsByWorktree: Object.fromEntries(
      worktrees.map((wt) => [
        wt.id,
        [
          {
            id: 'group-1',
            worktreeId: wt.id,
            activeTabId: wt.tabId,
            tabOrder: [wt.tabId]
          }
        ]
      ])
    ),
    layoutByWorktree: Object.fromEntries(
      worktrees.map((wt) => [wt.id, { type: 'leaf' as const, groupId: 'group-1' }])
    )
  }
}

/** A snapshot whose terminal mirror is missing, which is what makes the pane a candidate. */
function missingSnapshot(worktree: Worktree) {
  return {
    worktree: worktree.id,
    publicationEpoch: 'missing',
    snapshotVersion: 1,
    activeGroupId: 'group-1',
    activeTabId: `${worktree.hostTabId}::leaf-1`,
    activeTabType: 'terminal' as const,
    tabs: []
  }
}

function adoptedSnapshot(worktree: Worktree) {
  return {
    worktree: worktree.id,
    publicationEpoch: 'adopted',
    snapshotVersion: 2,
    activeGroupId: 'group-1',
    activeTabId: `${worktree.hostTabId}::leaf-1`,
    activeTabType: 'terminal' as const,
    tabs: [
      {
        type: 'terminal' as const,
        id: `${worktree.hostTabId}::leaf-1`,
        parentTabId: worktree.hostTabId,
        leafId: 'leaf-1',
        title: 'Claude',
        isActive: true,
        status: 'ready' as const,
        terminal: worktree.handle
      }
    ]
  }
}

/**
 * Models one runtime host: every fresh listing supersedes the one before it, so a
 * listing that has not returned when a later one starts is failed closed.
 */
function makeHost(worktrees: Worktree[], listLatencyMs = 10) {
  const byHandle = new Map(worktrees.map((wt) => [wt.handle, wt]))
  let generation = 0
  let inFlight = 0
  let maxInFlight = 0
  const adopted: string[] = []

  const call = async ({ method, params }: { method: string; params: unknown }) => {
    const { worktree, handles } = params as { worktree: string; handles?: string[] }
    if (method === 'terminal.list') {
      generation += 1
      const mine = generation
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, listLatencyMs))
      inFlight -= 1
      if (mine !== generation) {
        return { ok: false as const, error: { message: 'terminal_liveness_unavailable' } }
      }
      const listed = (handles ?? []).flatMap((handle) => {
        const wt = byHandle.get(handle)
        return wt
          ? [
              {
                handle,
                ptyId: `native-${handle}`,
                incarnationId: `inc-${handle}`,
                orphaned: true,
                worktreeId: wt.id
              }
            ]
          : []
      })
      return {
        ok: true as const,
        result: {
          terminals: listed,
          topologyRevisions: Object.fromEntries(worktrees.map((wt) => [wt.id, 0])),
          totalCount: listed.length,
          truncated: false
        }
      }
    }
    const wt = worktrees.find((candidate) => worktree.includes(candidate.id))!
    adopted.push(wt.id)
    return { ok: true as const, result: { snapshot: adoptedSnapshot(wt) } }
  }

  return {
    call,
    adopted,
    get maxInFlight() {
      return maxInFlight
    }
  }
}

describe('orphan recovery against one host', () => {
  beforeEach(() => {
    clearWebSessionTerminalOrphanRecoveryForTests()
    resetRuntimeHostQueueForTests()
  })

  it('recovers every worktree when a host is asked about several at once', async () => {
    const worktrees = [WORKTREE_A, WORKTREE_B]
    const host = makeHost(worktrees)
    const state = makeState(worktrees)

    // Why: web-session-tabs-sync fans recovery across a host's snapshots with Promise.all.
    const recovered = await Promise.all(
      worktrees.map((wt) =>
        recoverWebSessionTerminalOrphansBeforeApply(
          state,
          missingSnapshot(wt),
          ENVIRONMENT_ID,
          host.call as never
        )
      )
    )

    expect(host.maxInFlight).toBe(1)
    expect(recovered.map((snapshot) => snapshot?.worktree ?? null)).toEqual([
      WORKTREE_A.id,
      WORKTREE_B.id
    ])
    expect([...host.adopted].sort()).toEqual([WORKTREE_A.id, WORKTREE_B.id])
  })

  it('does not let one unresponsive host hold up another', async () => {
    const stuckWorktree: Worktree = { ...WORKTREE_A, handle: 'term_stuck' }
    const stuckHost = makeHost([stuckWorktree], 60_000)
    const liveHost = makeHost([WORKTREE_B])

    const stuck = recoverWebSessionTerminalOrphansBeforeApply(
      makeState([stuckWorktree], 'hung-host'),
      missingSnapshot(stuckWorktree),
      'hung-host',
      stuckHost.call as never
    )
    const live = await recoverWebSessionTerminalOrphansBeforeApply(
      makeState([WORKTREE_B]),
      missingSnapshot(WORKTREE_B),
      ENVIRONMENT_ID,
      liveHost.call as never
    )

    expect(live?.worktree).toBe(WORKTREE_B.id)
    expect(liveHost.adopted).toEqual([WORKTREE_B.id])
    void stuck
  })
})
