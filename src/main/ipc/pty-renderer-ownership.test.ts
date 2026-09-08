import { describe, it, expect } from 'vitest'
import type { BrowserWindow } from 'electron'
import { createPtyRendererOwnership } from './pty-renderer-ownership'

const WINDOW_A = 11
const WINDOW_B = 22

function makeOwnership(liveWebContentsIds: number[]) {
  const windows = new Map<number, BrowserWindow>(
    liveWebContentsIds.map((id) => [id, { id } as unknown as BrowserWindow])
  )
  return {
    windows,
    ownership: createPtyRendererOwnership({
      liveWindowForWebContentsId: (id) => windows.get(id) ?? null
    })
  }
}

describe('createPtyRendererOwnership', () => {
  it('routes each PTY to the window that asked for it', () => {
    // Arrange
    const { windows, ownership } = makeOwnership([WINDOW_A, WINDOW_B])

    // Act
    ownership.claim('pty-a', WINDOW_A)
    ownership.claim('pty-b', WINDOW_B)

    // Assert — the point of the whole exercise: disjoint terminals, disjoint destinations.
    expect(ownership.ownerWindowFor('pty-a')).toBe(windows.get(WINDOW_A))
    expect(ownership.ownerWindowFor('pty-b')).toBe(windows.get(WINDOW_B))
  })

  it('reports no owner for a PTY nobody claimed', () => {
    // Arrange
    const { ownership } = makeOwnership([WINDOW_A])

    // Act / Assert — the caller falls back to the primary window rather than dropping output.
    expect(ownership.ownerWindowFor('pty-unclaimed')).toBeNull()
  })

  it('reports no owner once the owning window is gone', () => {
    // Arrange
    const { windows, ownership } = makeOwnership([WINDOW_A])
    ownership.claim('pty-a', WINDOW_A)

    // Act — the window closes without its PTYs being released first.
    windows.delete(WINDOW_A)

    // Assert — a dead window must never be returned as a delivery target.
    expect(ownership.ownerWindowFor('pty-a')).toBeNull()
    // The record survives so the caller can still tell whose terminal it was.
    expect(ownership.ownerWebContentsIdFor('pty-a')).toBe(WINDOW_A)
  })

  it('releases one PTY without disturbing the others', () => {
    // Arrange
    const { windows, ownership } = makeOwnership([WINDOW_A])
    ownership.claim('pty-a', WINDOW_A)
    ownership.claim('pty-b', WINDOW_A)

    // Act
    ownership.release('pty-a')

    // Assert
    expect(ownership.ownerWindowFor('pty-a')).toBeNull()
    expect(ownership.ownerWindowFor('pty-b')).toBe(windows.get(WINDOW_A))
  })

  it('hands back what a closed window owned, and only that', () => {
    // Arrange
    const { ownership } = makeOwnership([WINDOW_A, WINDOW_B])
    ownership.claim('pty-a1', WINDOW_A)
    ownership.claim('pty-a2', WINDOW_A)
    ownership.claim('pty-b1', WINDOW_B)

    // Act
    const orphaned = ownership.releaseWindow(WINDOW_A)

    // Assert — the other window's terminals are none of this window's business.
    expect(orphaned.sort()).toEqual(['pty-a1', 'pty-a2'])
    expect(ownership.ownedPtyIds(WINDOW_B)).toEqual(['pty-b1'])
    expect(ownership.size()).toBe(1)
  })

  it('re-claims a reused PTY id to its new owner', () => {
    // Arrange — ids can be reused after an exit, which releases the record first.
    const { windows, ownership } = makeOwnership([WINDOW_A, WINDOW_B])
    ownership.claim('pty-a', WINDOW_A)
    ownership.release('pty-a')

    // Act
    ownership.claim('pty-a', WINDOW_B)

    // Assert
    expect(ownership.ownerWindowFor('pty-a')).toBe(windows.get(WINDOW_B))
    expect(ownership.ownedPtyIds(WINDOW_A)).toEqual([])
  })

  it('refuses to move a live terminal to a second window', () => {
    // Arrange — one live PTY, owned by A, with A still open.
    const { windows, ownership } = makeOwnership([WINDOW_A, WINDOW_B])
    ownership.claim('pty-a', WINDOW_A)

    // Act — B asks for the same session. A reattach returns the id it already has, and the spawn
    // handler claims from whoever asked, so this is one unguarded call away from happening.
    ownership.claim('pty-a', WINDOW_B)

    // Assert — both halves, because a half-moved terminal is the failure this prevents: input is
    // admitted by equality against the owner and output is routed through it, so a silent move
    // leaves A rendering an ordinary prompt it can neither type into nor hear back from.
    expect(ownership.ownerWindowFor('pty-a')).toBe(windows.get(WINDOW_A))
    expect(ownership.ownedPtyIds(WINDOW_A)).toEqual(['pty-a'])
    expect(ownership.ownedPtyIds(WINDOW_B)).toEqual([])
  })

  it('lets a replacement renderer take over the terminals its predecessor left', () => {
    // Arrange — the owning renderer is gone, which is what crash recovery looks like from here:
    // the window survives, its webContents does not.
    const { windows, ownership } = makeOwnership([WINDOW_A, WINDOW_B])
    ownership.claim('pty-a', WINDOW_A)
    windows.delete(WINDOW_A)

    // Act
    ownership.claim('pty-a', WINDOW_B)

    // Assert — refusing here would strand a terminal on a renderer that no longer exists, which is
    // the opposite failure and just as bad. Only a *live* owner is protected.
    expect(ownership.ownerWindowFor('pty-a')).toBe(windows.get(WINDOW_B))
  })

  it('keeps a re-claim by the same renderer a no-op', () => {
    // Arrange — a reattach by the window that already owns the PTY is the ordinary case.
    const { windows, ownership } = makeOwnership([WINDOW_A])
    ownership.claim('pty-a', WINDOW_A)

    // Act
    ownership.claim('pty-a', WINDOW_A)

    // Assert
    expect(ownership.ownerWindowFor('pty-a')).toBe(windows.get(WINDOW_A))
    expect(ownership.ownedPtyIds(WINDOW_A)).toEqual(['pty-a'])
  })
})
