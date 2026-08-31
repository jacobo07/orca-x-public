// The renderer publishes its whole store as one snapshot. With two windows that is last-writer-wins,
// so the second window erases the first window's tabs — silently, and durably. This is the scope
// that bounds the blast radius, and it is derived in main from the sender rather than taken from the
// wire, because a renderer that named its own scope could name someone else's worktrees.
import { beforeEach, describe, expect, it } from 'vitest'

import { resolveSessionWriteScope } from './session-write-scope'
import {
  claimWorkspaceForWindow,
  registerWorkspaceWindow,
  resetWorkspaceWindowRegistryForTest
} from '../window/workspace-window-registry'

const REPO = 'repo-1'
const WORKTREE_A = 'repo-1::/repos/one/main'
const WORKTREE_B = 'repo-1::/repos/one/feature'
const RENDERER_A = 11
const RENDERER_B = 22

describe('session write scope', () => {
  beforeEach(() => {
    resetWorkspaceWindowRegistryForTest()
  })

  it('gives a lone window whole-workspace authority', () => {
    const only = registerWorkspaceWindow({ browserWindowId: 1, rendererWebContentsId: RENDERER_A })
    claimWorkspaceForWindow(only.windowId, { repoId: REPO, worktreeId: WORKTREE_A })

    // One window legitimately holds the state of every project it has visited; scoping it to the
    // one project it currently shows would stop the rest from ever being written again.
    expect(resolveSessionWriteScope(RENDERER_A)).toEqual({})
  })

  it('scopes each window to the workspace it owns once a second window exists', () => {
    const first = registerWorkspaceWindow({ browserWindowId: 1, rendererWebContentsId: RENDERER_A })
    const second = registerWorkspaceWindow({
      browserWindowId: 2,
      rendererWebContentsId: RENDERER_B
    })
    claimWorkspaceForWindow(first.windowId, { repoId: REPO, worktreeId: WORKTREE_A })
    claimWorkspaceForWindow(second.windowId, { repoId: REPO, worktreeId: WORKTREE_B })

    expect(resolveSessionWriteScope(RENDERER_A)).toEqual({ ownedWorktreeIds: [WORKTREE_A] })
    expect(resolveSessionWriteScope(RENDERER_B)).toEqual({ ownedWorktreeIds: [WORKTREE_B] })
  })

  it('lets an unbound window write nothing rather than everything', () => {
    registerWorkspaceWindow({ browserWindowId: 1, rendererWebContentsId: RENDERER_A })
    const second = registerWorkspaceWindow({
      browserWindowId: 2,
      rendererWebContentsId: RENDERER_B
    })
    claimWorkspaceForWindow(second.windowId, { repoId: REPO, worktreeId: WORKTREE_B })

    // A launcher-only window owns no project. Publishing unscoped from there is exactly how a
    // window showing no project would erase the projects every other window is holding.
    expect(resolveSessionWriteScope(RENDERER_A)).toEqual({ ownedWorktreeIds: [] })
  })

  it('gives an unrecognised sender an empty scope, not whole-workspace authority', () => {
    registerWorkspaceWindow({ browserWindowId: 1, rendererWebContentsId: RENDERER_A })
    registerWorkspaceWindow({ browserWindowId: 2, rendererWebContentsId: RENDERER_B })

    expect(resolveSessionWriteScope(999)).toEqual({ ownedWorktreeIds: [] })
  })
})
