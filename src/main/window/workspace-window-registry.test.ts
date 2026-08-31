import { beforeEach, describe, expect, it } from 'vitest'

import {
  claimWorkspaceForWindow,
  getOwnedWorktreeIds,
  getWorkspaceWindow,
  getWorkspaceWindowForRenderer,
  getWorkspaceWindowForWorktree,
  listWorkspaceWindows,
  registerWorkspaceWindow,
  releaseWorkspaceForWindow,
  resetWorkspaceWindowRegistryForTest,
  setWorkspaceWindowRenderer,
  unregisterWorkspaceWindow
} from './workspace-window-registry'

const REPO = 'repo-1'
const WORKTREE_A = 'repo-1::/repos/one/main'
const WORKTREE_B = 'repo-1::/repos/one/feature'

function registerWindow(browserWindowId: number, rendererWebContentsId: number): string {
  return registerWorkspaceWindow({ browserWindowId, rendererWebContentsId }).windowId
}

describe('workspace window registry', () => {
  beforeEach(() => {
    resetWorkspaceWindowRegistryForTest()
  })

  it('mints a distinct identity per window', () => {
    const first = registerWindow(1, 11)
    const second = registerWindow(2, 22)

    expect(first).not.toBe(second)
    expect(listWorkspaceWindows()).toHaveLength(2)
  })

  it('starts a window unbound, owning no worktree', () => {
    const windowId = registerWindow(1, 11)

    expect(getWorkspaceWindow(windowId)?.binding).toBeNull()
    expect(getOwnedWorktreeIds(windowId)).toEqual([])
  })

  it('resolves a window from the renderer currently driving it', () => {
    const windowId = registerWindow(1, 11)

    expect(getWorkspaceWindowForRenderer(11)?.windowId).toBe(windowId)
    expect(getWorkspaceWindowForRenderer(99)).toBeNull()
  })

  it('keeps the window and its binding when its renderer is replaced', () => {
    const windowId = registerWindow(1, 11)
    claimWorkspaceForWindow(windowId, { repoId: REPO, worktreeId: WORKTREE_A })

    // A reload or crash recovery swaps the webContents; the window and its project survive.
    setWorkspaceWindowRenderer(windowId, 12)

    expect(getWorkspaceWindowForRenderer(12)?.windowId).toBe(windowId)
    expect(getWorkspaceWindowForRenderer(11)).toBeNull()
    expect(getOwnedWorktreeIds(windowId)).toEqual([WORKTREE_A])
  })

  it('binds a workspace to the window that claimed it', () => {
    const windowId = registerWindow(1, 11)

    expect(claimWorkspaceForWindow(windowId, { repoId: REPO, worktreeId: WORKTREE_A })).toEqual({
      outcome: 'claimed'
    })
    expect(getWorkspaceWindowForWorktree(WORKTREE_A)?.windowId).toBe(windowId)
    expect(getOwnedWorktreeIds(windowId)).toEqual([WORKTREE_A])
  })

  it('refuses a worktree another window already owns, and names the owner', () => {
    const first = registerWindow(1, 11)
    const second = registerWindow(2, 22)
    claimWorkspaceForWindow(first, { repoId: REPO, worktreeId: WORKTREE_A })

    const result = claimWorkspaceForWindow(second, { repoId: REPO, worktreeId: WORKTREE_A })

    expect(result).toEqual({ outcome: 'owned-by-another-window', ownerWindowId: first })
    // The refusal must not disturb the owner, and must leave the requester unbound.
    expect(getWorkspaceWindowForWorktree(WORKTREE_A)?.windowId).toBe(first)
    expect(getOwnedWorktreeIds(second)).toEqual([])
  })

  it('allows two worktrees of one repository in separate windows', () => {
    const first = registerWindow(1, 11)
    const second = registerWindow(2, 22)

    expect(claimWorkspaceForWindow(first, { repoId: REPO, worktreeId: WORKTREE_A }).outcome).toBe(
      'claimed'
    )
    expect(claimWorkspaceForWindow(second, { repoId: REPO, worktreeId: WORKTREE_B }).outcome).toBe(
      'claimed'
    )
    expect(getOwnedWorktreeIds(first)).toEqual([WORKTREE_A])
    expect(getOwnedWorktreeIds(second)).toEqual([WORKTREE_B])
  })

  it('reports a re-claim by the same window as already owned rather than as a conflict', () => {
    const windowId = registerWindow(1, 11)
    claimWorkspaceForWindow(windowId, { repoId: REPO, worktreeId: WORKTREE_A })

    expect(claimWorkspaceForWindow(windowId, { repoId: REPO, worktreeId: WORKTREE_A })).toEqual({
      outcome: 'already-owned-by-this-window'
    })
  })

  it('frees a worktree for another window once the owner releases it', () => {
    const first = registerWindow(1, 11)
    const second = registerWindow(2, 22)
    claimWorkspaceForWindow(first, { repoId: REPO, worktreeId: WORKTREE_A })

    releaseWorkspaceForWindow(first)

    expect(claimWorkspaceForWindow(second, { repoId: REPO, worktreeId: WORKTREE_A }).outcome).toBe(
      'claimed'
    )
  })

  it('frees a worktree when its window closes', () => {
    const first = registerWindow(1, 11)
    const second = registerWindow(2, 22)
    claimWorkspaceForWindow(first, { repoId: REPO, worktreeId: WORKTREE_A })

    unregisterWorkspaceWindow(first)

    expect(getWorkspaceWindowForWorktree(WORKTREE_A)).toBeNull()
    expect(claimWorkspaceForWindow(second, { repoId: REPO, worktreeId: WORKTREE_A }).outcome).toBe(
      'claimed'
    )
  })

  it('does not close over a window it has never seen', () => {
    expect(
      claimWorkspaceForWindow('window-never-registered', { repoId: REPO, worktreeId: WORKTREE_A })
    ).toEqual({ outcome: 'unknown-window' })
    expect(getWorkspaceWindowForWorktree(WORKTREE_A)).toBeNull()
  })
})
