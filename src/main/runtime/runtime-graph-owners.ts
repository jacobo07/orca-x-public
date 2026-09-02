import type { RuntimeGraphStatus } from '../../shared/runtime-types'
import type { RuntimeGraphReloadLifecycle } from './runtime-graph-reload-lifecycle'

/**
 * One window's claim on the runtime graph.
 *
 * The service stores tabs, leaves and handles in flat maps and will keep doing so: ownership is
 * derivable — every synced tab and leaf carries a `worktreeId`, and a worktree binds to at most one
 * window — so sharding the maps would buy nothing and would cost an owner argument at every one of
 * the thousands of read sites. What actually has to be per-window is the *invalidation* unit: the
 * state a reload, a close or a failure destroys. Those paths clear whole maps today, which is how
 * one window reloading strips another window's live terminal handles.
 */
export type RuntimeGraphOwner = {
  readonly windowId: number
  status: RuntimeGraphStatus
  /**
   * The value of the registry's monotonic counter when this owner's graph last turned over.
   *
   * Monotonic and process-wide so two owners can never mint the same epoch, but stored per owner so
   * that advancing one leaves the other's handles and in-flight fences valid. A handle records the
   * epoch of the owner that issued it and is stale only when *that* owner has moved on.
   */
  epoch: number
  rendererGeneration: string | null
  readonly reload: RuntimeGraphReloadLifecycle
  readonly tabIds: Set<string>
  readonly leafKeys: Set<string>
  readonly worktreeIds: Set<string>
}

/**
 * Every owner's epoch at one instant, taken before an async gap and checked after it.
 *
 * A single number cannot express this once there are two owners: the awaiting operation only cares
 * that *its* window's graph held still, and comparing against a process-global counter would fail it
 * because an unrelated window reloaded.
 */
export type RuntimeGraphEpochToken = ReadonlyMap<number, number>

export class RuntimeGraphOwnerRegistry {
  private readonly owners = new Map<number, RuntimeGraphOwner>()
  private epochCounter = 0

  constructor(private readonly createReloadLifecycle: () => RuntimeGraphReloadLifecycle) {}

  attach(windowId: number): RuntimeGraphOwner {
    const existing = this.owners.get(windowId)
    if (existing) {
      return existing
    }
    const owner: RuntimeGraphOwner = {
      windowId,
      status: 'unavailable',
      // Why the current value rather than a fresh one: attaching a window is not a graph turnover.
      // Minting here would start the wire's epoch at 1 on a cold runtime and step it once per
      // window, and remote clients read that number.
      epoch: this.epochCounter,
      rendererGeneration: null,
      reload: this.createReloadLifecycle(),
      tabIds: new Set(),
      leafKeys: new Set(),
      worktreeIds: new Set()
    }
    this.owners.set(windowId, owner)
    return owner
  }

  get(windowId: number): RuntimeGraphOwner | undefined {
    return this.owners.get(windowId)
  }

  has(windowId: number): boolean {
    return this.owners.has(windowId)
  }

  delete(windowId: number): void {
    this.owners.delete(windowId)
  }

  clear(): void {
    this.owners.clear()
  }

  get size(): number {
    return this.owners.size
  }

  list(): RuntimeGraphOwner[] {
    return [...this.owners.values()]
  }

  ids(): number[] {
    return [...this.owners.keys()]
  }

  /** The only owner, or null when there are none or more than one. */
  sole(): RuntimeGraphOwner | null {
    return this.owners.size === 1 ? (this.owners.values().next().value ?? null) : null
  }

  /** Advance one owner's graph generation. Every other owner's epoch is untouched, which is the point. */
  advanceEpoch(owner: RuntimeGraphOwner): number {
    owner.epoch = this.epochCounter += 1
    return owner.epoch
  }

  /**
   * The status a caller with no window in scope should see.
   *
   * Ready wins over reloading, and reloading over unavailable: a runtime with one healthy window is
   * usable even while another window is rebuilding, and reporting it unavailable would fail
   * operations that have a perfectly good graph to run against.
   */
  aggregateStatus(): RuntimeGraphStatus {
    let sawReloading = false
    for (const owner of this.owners.values()) {
      if (owner.status === 'ready') {
        return 'ready'
      }
      sawReloading ||= owner.status === 'reloading'
    }
    return sawReloading ? 'reloading' : 'unavailable'
  }

  /**
   * The wire's single `rendererGraphEpoch`.
   *
   * The counter, not the highest owner epoch: it must keep counting after the last window
   * disappears, which is exactly when a remote client needs to see that the graph turned over.
   * Taking a maximum over an empty owner set would reset it to zero and read as a fresh runtime.
   */
  currentEpoch(): number {
    return this.epochCounter
  }

  ownerOfWorktree(worktreeId: string | null | undefined): RuntimeGraphOwner | null {
    if (worktreeId) {
      for (const owner of this.owners.values()) {
        if (owner.worktreeIds.has(worktreeId)) {
          return owner
        }
      }
    }
    // Why: a worktree with no published surface — a background PTY, a headless graph — still has to
    // resolve somewhere. With one window that is unambiguously the answer, which keeps every
    // single-window path byte-identical; with several, refusing to guess is the safe direction.
    return this.sole()
  }

  ownerOfLeafKey(leafKey: string): RuntimeGraphOwner | null {
    for (const owner of this.owners.values()) {
      if (owner.leafKeys.has(leafKey)) {
        return owner
      }
    }
    return this.sole()
  }

  ownerOfTab(tabId: string): RuntimeGraphOwner | null {
    for (const owner of this.owners.values()) {
      if (owner.tabIds.has(tabId)) {
        return owner
      }
    }
    return this.sole()
  }

  captureEpochs(): RuntimeGraphEpochToken {
    const epochs = new Map<number, number>()
    for (const owner of this.owners.values()) {
      epochs.set(owner.windowId, owner.epoch)
    }
    return epochs
  }

  /**
   * Whether the graph the token was taken against still holds.
   *
   * With a window in scope only that window is checked, so an unrelated reload cannot fail the
   * caller. Without one, every owner recorded in the token must still be at its recorded epoch —
   * which for a single window is exactly the old global comparison.
   */
  epochsStillHold(token: RuntimeGraphEpochToken, owner: RuntimeGraphOwner | null): boolean {
    if (owner) {
      return token.get(owner.windowId) === owner.epoch
    }
    for (const [windowId, epoch] of token) {
      if (this.owners.get(windowId)?.epoch !== epoch) {
        return false
      }
    }
    return true
  }
}
