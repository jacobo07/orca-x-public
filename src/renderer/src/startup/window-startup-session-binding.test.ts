import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { applyWindowStartupBinding } from './window-startup-session-binding'

type Startup = { worktreeId: string | null; restoreSession: boolean }
type ClaimOutcome = 'claimed' | 'already-owned-by-this-window' | 'owned-by-another-window'

const SESSION = { activeWorktreeId: 'worktree-a', activeRepoId: 'repo-a', activeTabId: 'tab-a' }

function stubWindowApi(options: {
  startup: Startup | (() => never)
  claim?: ClaimOutcome | (() => never)
}) {
  const claimWorkspace = vi.fn(async () => {
    if (typeof options.claim === 'function') {
      options.claim()
    }
    return { outcome: options.claim ?? 'claimed' }
  })
  const getStartupBinding = vi.fn(async () => {
    if (typeof options.startup === 'function') {
      options.startup()
    }
    return options.startup
  })
  vi.stubGlobal('window', { api: { ui: { getStartupBinding, claimWorkspace } } })
  return { claimWorkspace, getStartupBinding }
}

describe('applyWindowStartupBinding', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('claims the project the restoring window is about to show', async () => {
    // Arrange — the first window: main says "restore what you had" and names no worktree, so the
    // registry has no binding for whatever the session turns out to name.
    const { claimWorkspace } = stubWindowApi({
      startup: { worktreeId: null, restoreSession: true }
    })

    // Act
    const result = await applyWindowStartupBinding(SESSION)

    // Assert — without this the worktree reads as free, and a second window may take it: one tab,
    // one PTY, two windows.
    expect(claimWorkspace).toHaveBeenCalledWith({ repoId: 'repo-a', worktreeId: 'worktree-a' })
    expect(result.activeWorktreeId).toBe('worktree-a')
  })

  it('starts on the launcher when another window already owns the saved project', async () => {
    // Arrange
    stubWindowApi({
      startup: { worktreeId: null, restoreSession: true },
      claim: 'owned-by-another-window'
    })

    // Act
    const result = await applyWindowStartupBinding(SESSION)

    // Assert — showing a project this window does not own is the state being prevented, so a
    // refusal has to cost the pointers and not only the binding.
    expect(result.activeWorktreeId).toBeNull()
    expect(result.activeRepoId).toBeNull()
  })

  it('does not re-claim for a window main already answered with a binding', async () => {
    // Arrange — a bound window, which is also how a reload comes back.
    const { claimWorkspace } = stubWindowApi({
      startup: { worktreeId: 'worktree-b', restoreSession: true }
    })

    // Act
    const result = await applyWindowStartupBinding(SESSION)

    // Assert — that answer is itself the product of a claim; asking again would be a second writer
    // of the same record for no gain.
    expect(claimWorkspace).not.toHaveBeenCalled()
    expect(result.activeWorktreeId).toBe('worktree-b')
  })

  it('blanks the active project for a window told not to restore', async () => {
    // Arrange
    const { claimWorkspace } = stubWindowApi({
      startup: { worktreeId: null, restoreSession: false }
    })

    // Act
    const result = await applyWindowStartupBinding(SESSION)

    // Assert
    expect(result.activeWorktreeId).toBeNull()
    expect(result.activeRepoId).toBeNull()
    expect(claimWorkspace).not.toHaveBeenCalled()
  })

  it('keeps the saved project when the claim cannot be reached', async () => {
    // Arrange — an older main process, or a handler that throws.
    stubWindowApi({
      startup: { worktreeId: null, restoreSession: true },
      claim: () => {
        throw new Error('no such handler')
      }
    })

    // Act
    const result = await applyWindowStartupBinding(SESSION)

    // Assert — a window with nothing on screen is a worse answer than one showing the project it
    // had, and this failure leaves it exactly where it was before the claim existed.
    expect(result.activeWorktreeId).toBe('worktree-a')
  })

  it('does not claim a session that names no project', async () => {
    // Arrange — nothing to own, and `undefined` must not be sent as a worktree id.
    const { claimWorkspace } = stubWindowApi({
      startup: { worktreeId: null, restoreSession: true }
    })

    // Act
    const result = await applyWindowStartupBinding({ activeWorktreeId: null, activeRepoId: null })

    // Assert
    expect(claimWorkspace).not.toHaveBeenCalled()
    expect(result.activeWorktreeId).toBeNull()
  })
})
