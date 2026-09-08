import type { BrowserWindow } from 'electron'

/**
 * Which renderer a PTY's output belongs to.
 *
 * Terminal delivery was written for one consumer: the sends close over a single window, and
 * re-registering handlers is how a *new* window takes over delivery. One project window per
 * project makes that assumption false — two windows own disjoint terminals at the same time, and
 * output must reach the window that asked for it rather than whichever registered last.
 *
 * Ownership is claimed where it is known for free (the renderer that requested the spawn) and
 * released where the PTY ends. A PTY with no live owner falls back to the primary window rather
 * than dropping its output: a terminal whose window has gone is a terminal to re-home, not one to
 * silence.
 */

export type PtyRendererOwnership = {
  /** Record the renderer that requested this PTY, unless a live renderer already owns it. */
  claim: (ptyId: string, ownerWebContentsId: number) => void
  /** Forget one PTY, on exit. */
  release: (ptyId: string) => void
  /** Forget everything a closed window owned. Returns the PTYs that lost their owner. */
  releaseWindow: (webContentsId: number) => string[]
  /** The live window that owns this PTY, or null when it has none. */
  ownerWindowFor: (ptyId: string) => BrowserWindow | null
  /** The webContents id recorded for this PTY, whether or not it is still alive. */
  ownerWebContentsIdFor: (ptyId: string) => number | null
  /** Every PTY currently attributed to a window. */
  ownedPtyIds: (webContentsId: number) => string[]
  size: () => number
}

export type PtyRendererOwnershipDeps = {
  /** Resolve a live, usable window from a webContents id; null once it is gone. */
  liveWindowForWebContentsId: (webContentsId: number) => BrowserWindow | null
}

export function createPtyRendererOwnership({
  liveWindowForWebContentsId
}: PtyRendererOwnershipDeps): PtyRendererOwnership {
  const ownerWebContentsIdByPtyId = new Map<string, number>()

  return {
    claim(ptyId, ownerWebContentsId) {
      // Why a claim can be refused: ownership is claimed from whoever asked for the terminal, and a
      // reattach asks for one that already exists. So a second renderer requesting a live session
      // would take it — and because input is admitted by equality against this record and output is
      // routed through it, that takes both at once, leaving the previous owner showing an ordinary
      // prompt it can no longer type into or hear back from.
      //
      // Only a *live* different renderer is protected. An id whose record was released on exit is
      // free to be reused, and an owner whose renderer is gone must be replaceable or a crash would
      // strand its terminals on a webContents that no longer exists.
      const currentOwnerId = ownerWebContentsIdByPtyId.get(ptyId)
      if (
        currentOwnerId !== undefined &&
        currentOwnerId !== ownerWebContentsId &&
        liveWindowForWebContentsId(currentOwnerId)
      ) {
        return
      }
      ownerWebContentsIdByPtyId.set(ptyId, ownerWebContentsId)
    },
    release(ptyId) {
      ownerWebContentsIdByPtyId.delete(ptyId)
    },
    releaseWindow(webContentsId) {
      const orphaned: string[] = []
      for (const [ptyId, ownerId] of ownerWebContentsIdByPtyId) {
        if (ownerId === webContentsId) {
          orphaned.push(ptyId)
        }
      }
      for (const ptyId of orphaned) {
        ownerWebContentsIdByPtyId.delete(ptyId)
      }
      return orphaned
    },
    ownerWindowFor(ptyId) {
      const ownerId = ownerWebContentsIdByPtyId.get(ptyId)
      return ownerId === undefined ? null : liveWindowForWebContentsId(ownerId)
    },
    ownerWebContentsIdFor(ptyId) {
      return ownerWebContentsIdByPtyId.get(ptyId) ?? null
    },
    ownedPtyIds(webContentsId) {
      const owned: string[] = []
      for (const [ptyId, ownerId] of ownerWebContentsIdByPtyId) {
        if (ownerId === webContentsId) {
          owned.push(ptyId)
        }
      }
      return owned
    },
    size() {
      return ownerWebContentsIdByPtyId.size
    }
  }
}
