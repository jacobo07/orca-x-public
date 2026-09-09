import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  claimActiveWorkspaceForWindow,
  resetActiveWorkspaceClaimForTest,
  type ActiveWorkspaceClaim
} from './active-workspace-window-claim'

type Outcome = 'claimed' | 'already-owned' | 'owned-by-another-window' | 'unknown-window'

const claimWorkspace = vi.fn<
  (request: { repoId: string; worktreeId: string }) => Promise<{ outcome: Outcome }>
>()
vi.stubGlobal('window', { api: { ui: { claimWorkspace } } })

const revertTo = vi.fn<(worktreeId: string | null) => void>()
let onScreen: string | null = 'worktree-b'

function claimOf(overrides: Partial<ActiveWorkspaceClaim> = {}): ActiveWorkspaceClaim {
  return {
    repoId: 'repo-a',
    worktreeId: 'worktree-b',
    previousWorktreeId: 'worktree-a',
    currentWorktreeId: () => onScreen,
    revertTo,
    ...overrides
  }
}

/** The claim is fired without being awaited, so let its continuation run. */
const settle = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('claimActiveWorkspaceForWindow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetActiveWorkspaceClaimForTest()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    onScreen = 'worktree-b'
    claimWorkspace.mockResolvedValue({ outcome: 'claimed' })
  })

  it('claims the project the window switched to', async () => {
    // Act
    claimActiveWorkspaceForWindow(claimOf())
    await settle()

    // Assert — without this the worktree on screen reads as unowned, and the binding still names the
    // one the user left. Claiming the new one releases the old in the same operation.
    expect(claimWorkspace).toHaveBeenCalledWith({ repoId: 'repo-a', worktreeId: 'worktree-b' })
    expect(revertTo).not.toHaveBeenCalled()
  })

  it('puts the window back when the project belongs to another window', async () => {
    // Arrange
    claimWorkspace.mockResolvedValue({ outcome: 'owned-by-another-window' })

    // Act
    claimActiveWorkspaceForWindow(claimOf())
    await settle()

    // Assert — main has already revealed the owner, so the user is looking at the project in the
    // window that holds it. This window must not stay on a project it does not own.
    expect(revertTo).toHaveBeenCalledWith('worktree-a')
  })

  it('leaves a launcher window on the launcher when its target is taken', async () => {
    // Arrange — a window with no project of its own has nothing to fall back to.
    claimWorkspace.mockResolvedValue({ outcome: 'owned-by-another-window' })

    // Act
    claimActiveWorkspaceForWindow(claimOf({ previousWorktreeId: null }))
    await settle()

    // Assert
    expect(revertTo).toHaveBeenCalledWith(null)
  })

  it('ignores a refusal that arrives after another switch replaced it', async () => {
    // Arrange
    claimWorkspace.mockResolvedValue({ outcome: 'owned-by-another-window' })

    // Act — a second switch starts before the first one is answered.
    claimActiveWorkspaceForWindow(claimOf())
    claimWorkspace.mockResolvedValue({ outcome: 'claimed' })
    claimActiveWorkspaceForWindow(claimOf({ worktreeId: 'worktree-c' }))
    await settle()

    // Assert — applying the stale refusal would drag the window off a project it legitimately holds.
    expect(revertTo).not.toHaveBeenCalled()
  })

  it('ignores a refusal for a project the window has already left', async () => {
    // Arrange — the switch was answered, but the window moved on in the meantime.
    claimWorkspace.mockResolvedValue({ outcome: 'owned-by-another-window' })
    onScreen = 'worktree-c'

    // Act
    claimActiveWorkspaceForWindow(claimOf())
    await settle()

    // Assert
    expect(revertTo).not.toHaveBeenCalled()
  })

  it('does not bind a surface that owns no project', async () => {
    // Arrange — a cleared workspace, or a standalone surface such as the floating terminal: it has a
    // tab bucket but no worktree. Claiming it would release the window's real project.

    // Act
    claimActiveWorkspaceForWindow(claimOf({ repoId: null }))
    await settle()

    // Assert
    expect(claimWorkspace).not.toHaveBeenCalled()
    expect(revertTo).not.toHaveBeenCalled()
  })

  it('keeps the project on screen when the claim cannot be reached', async () => {
    // Arrange
    claimWorkspace.mockRejectedValue(new Error('no such handler'))

    // Act
    claimActiveWorkspaceForWindow(claimOf())
    await settle()

    // Assert — a stale binding is a worse outcome than none, but taking the user's project off screen
    // because an IPC failed is worse than both.
    expect(revertTo).not.toHaveBeenCalled()
  })
})
