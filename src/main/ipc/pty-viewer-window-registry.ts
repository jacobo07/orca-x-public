/**
 * Which renderer windows can currently *present* each PTY.
 *
 * Main already knew which pane was showing a PTY, because the renderer reports that per mounted
 * transport. What it could not know is whether the window holding that pane is on screen: the pane
 * claim stays true when the OS minimizes the window, so a minimized window looked identical to a
 * focused one. That is the single state where the app believes a terminal is visible and the
 * renderer can neither draw it nor drain it — and delivery policy keyed on the pane claim alone
 * therefore keeps a minimized window's PTYs under full producer flow control, which pauses the
 * writing process rather than merely its rendering.
 *
 * Claims are keyed by the window that made them because minimizing one window must not change what
 * another window is showing. A process-global "is a window visible" flag cannot express that once
 * two windows coexist: it answers a question about the app when the question is about a PTY.
 *
 * Two directions are deliberate. A PTY nobody has claimed either way is *unknown*, not hidden, so
 * main keeps its existing behaviour until a renderer actually reports. And a window this registry
 * was never told about is assumed able to present, because guessing the other way would background
 * a terminal the user is looking at — lost output, to save nothing.
 */

/** `WebContents.id` of the renderer that made the claim. */
export type PtyViewerWindowKey = number

export class PtyViewerWindowRegistry {
  private readonly visibleWindowsByPty = new Map<string, Set<PtyViewerWindowKey>>()
  private readonly claimedPtysByWindow = new Map<PtyViewerWindowKey, Set<string>>()
  private readonly nonPresentableWindows = new Set<PtyViewerWindowKey>()

  /** Records one window's view of a PTY. Marks the PTY known in both directions. */
  setViewerVisibility(ptyId: string, windowKey: PtyViewerWindowKey, visible: boolean): void {
    let claimedPtys = this.claimedPtysByWindow.get(windowKey)
    if (!claimedPtys) {
      claimedPtys = new Set()
      this.claimedPtysByWindow.set(windowKey, claimedPtys)
    }
    claimedPtys.add(ptyId)

    let visibleWindows = this.visibleWindowsByPty.get(ptyId)
    if (!visibleWindows) {
      visibleWindows = new Set()
      this.visibleWindowsByPty.set(ptyId, visibleWindows)
    }
    if (visible) {
      visibleWindows.add(windowKey)
      return
    }
    visibleWindows.delete(windowKey)
  }

  /** Records whether a window can put pixels on screen at all — minimize, hide, restore. */
  setWindowPresentable(windowKey: PtyViewerWindowKey, presentable: boolean): void {
    if (presentable) {
      this.nonPresentableWindows.delete(windowKey)
      return
    }
    this.nonPresentableWindows.add(windowKey)
  }

  /** True once any renderer has reported this PTY's visibility in either direction. */
  isKnown(ptyId: string): boolean {
    return this.visibleWindowsByPty.has(ptyId)
  }

  /** True while at least one window both shows this PTY and can present. */
  hasPresentableViewer(ptyId: string): boolean {
    const visibleWindows = this.visibleWindowsByPty.get(ptyId)
    if (!visibleWindows) {
      return false
    }
    for (const windowKey of visibleWindows) {
      if (!this.nonPresentableWindows.has(windowKey)) {
        return true
      }
    }
    return false
  }

  /**
   * Every PTY this window has claimed, in either direction, so a minimize or restore can resync
   * exactly those rather than sweeping the whole process. Hidden claims are included: a hidden pane
   * in a returning window still needs re-evaluating, and skipping it would leave main's view stale.
   */
  ptyIdsClaimedByWindow(windowKey: PtyViewerWindowKey): string[] {
    return Array.from(this.claimedPtysByWindow.get(windowKey) ?? [])
  }

  /** Drops a closed window's claims, so a dead window cannot pin a PTY presentable forever. */
  forgetWindow(windowKey: PtyViewerWindowKey): void {
    this.nonPresentableWindows.delete(windowKey)
    const claimedPtys = this.claimedPtysByWindow.get(windowKey)
    this.claimedPtysByWindow.delete(windowKey)
    if (!claimedPtys) {
      return
    }
    for (const ptyId of claimedPtys) {
      const visibleWindows = this.visibleWindowsByPty.get(ptyId)
      if (!visibleWindows) {
        continue
      }
      visibleWindows.delete(windowKey)
      // Why drop the entry entirely: with no window claiming it either way, main is back to knowing
      // nothing about this PTY, which is not the same as knowing it is hidden.
      if (visibleWindows.size === 0 && !this.isClaimedByAnyWindow(ptyId)) {
        this.visibleWindowsByPty.delete(ptyId)
      }
    }
  }

  /** Drops a PTY outright — exit, kill, or id reuse. */
  forgetPty(ptyId: string): void {
    this.visibleWindowsByPty.delete(ptyId)
    for (const claimedPtys of this.claimedPtysByWindow.values()) {
      claimedPtys.delete(ptyId)
    }
  }

  clear(): void {
    this.visibleWindowsByPty.clear()
    this.claimedPtysByWindow.clear()
    this.nonPresentableWindows.clear()
  }

  private isClaimedByAnyWindow(ptyId: string): boolean {
    for (const claimedPtys of this.claimedPtysByWindow.values()) {
      if (claimedPtys.has(ptyId)) {
        return true
      }
    }
    return false
  }
}
