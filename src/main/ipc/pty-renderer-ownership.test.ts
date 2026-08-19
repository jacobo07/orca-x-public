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
    // Arrange — ids can be reused after an exit.
    const { windows, ownership } = makeOwnership([WINDOW_A, WINDOW_B])
    ownership.claim('pty-a', WINDOW_A)

    // Act
    ownership.claim('pty-a', WINDOW_B)

    // Assert
    expect(ownership.ownerWindowFor('pty-a')).toBe(windows.get(WINDOW_B))
    expect(ownership.ownedPtyIds(WINDOW_A)).toEqual([])
  })
})
