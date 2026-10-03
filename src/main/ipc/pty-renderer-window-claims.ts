/**
 * Which renderer window claimed each PTY visible or active (D6,
 * docs/reference/pty-multi-window-lifecycle-reset.md).
 *
 * The union sets stay the single read model for delivery policy; this keeps the per-window claims
 * behind them so a renderer lifecycle reset withdraws only what the dead page asserted.
 */

/** Why a key: a claim whose sender cannot be identified is withdrawn by any window's reset (fail closed). */
export const UNATTRIBUTED_RENDERER_WINDOW = -1

type Kind = 'visible' | 'active'

export class PtyRendererWindowClaims {
  private readonly claims: Record<Kind, Map<number, Set<string>>> = {
    visible: new Map(),
    active: new Map()
  }

  constructor(private readonly unions: Record<Kind, Set<string>>) {}

  /** Returns true when the union membership of the PTY changed. */
  set(kind: Kind, windowKey: number, ptyId: string, claimed: boolean): boolean {
    const byWindow = this.claims[kind]
    const owned = byWindow.get(windowKey) ?? new Set<string>()
    if (claimed) {
      owned.add(ptyId)
      byWindow.set(windowKey, owned)
    } else {
      owned.delete(ptyId)
    }
    return this.syncUnion(kind, ptyId)
  }

  /** Withdraws one window's claims; returns the PTYs that are no longer claimed by anyone, per kind. */
  withdrawWindow(windowKey: number): Record<Kind, string[]> {
    const dropped: Record<Kind, string[]> = { visible: [], active: [] }
    for (const kind of ['visible', 'active'] as const) {
      const byWindow = this.claims[kind]
      const affected = new Set([
        ...(byWindow.get(windowKey) ?? []),
        ...(byWindow.get(UNATTRIBUTED_RENDERER_WINDOW) ?? [])
      ])
      byWindow.delete(windowKey)
      byWindow.delete(UNATTRIBUTED_RENDERER_WINDOW)
      for (const ptyId of affected) {
        if (this.syncUnion(kind, ptyId) && !this.unions[kind].has(ptyId)) {
          dropped[kind].push(ptyId)
        }
      }
    }
    return dropped
  }

  forgetPty(ptyId: string): void {
    for (const kind of ['visible', 'active'] as const) {
      for (const owned of this.claims[kind].values()) {
        owned.delete(ptyId)
      }
      this.unions[kind].delete(ptyId)
    }
  }

  private syncUnion(kind: Kind, ptyId: string): boolean {
    const claimed = [...this.claims[kind].values()].some((owned) => owned.has(ptyId))
    const was = this.unions[kind].has(ptyId)
    if (claimed) {
      this.unions[kind].add(ptyId)
    } else {
      this.unions[kind].delete(ptyId)
    }
    return was !== claimed
  }
}
