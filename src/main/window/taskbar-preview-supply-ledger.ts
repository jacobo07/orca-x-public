/**
 * Fencing for taskbar thumbnails that are rasterized after the window procedure has returned.
 *
 * DWM accepts a late answer, which is what lets rasterization happen off the message path. The price
 * is that two answers can be in flight at once, and the one that finishes second is not necessarily
 * the one describing the newer screen. So every supply is checked against two facts before it is
 * allowed to become what the shell holds:
 *
 *   - the window incarnation it was rasterized for, because native handles are reused and a result
 *     for a closed window must never be applied to the one that took its place;
 *   - the generation of terminal truth it was rasterized from, because a slow render of an older
 *     screen must never overwrite a faster render of a newer one.
 *
 * This is also what makes a queue unnecessary. Terminal output advances the generation and nothing
 * else; a rasterizer always reads the *current* generation when it starts, so a burst of ninety
 * writes during one render produces one more render, not ninety. Intermediate frames are dropped on
 * purpose — the value of this surface is current state, not a complete history.
 *
 * Three counters that are never collapsed: what the terminal is now, what we last handed to Windows,
 * and what the user is actually looking at. Only the first two live here. The third is not knowable
 * from inside the process: the shell decides when to ask and when to repaint, so a successful supply
 * establishes that Windows accepted a bitmap, never that anyone saw it.
 */

export type TaskbarPreviewIncarnation = symbol

/**
 * The shell holds two unrelated bitmaps for one window and asks for them separately: a small
 * taskbar thumbnail and a window-sized live preview. They are different pictures at different
 * sizes, so they need different fences — one counter across both means answering either one marks
 * the other as already satisfied, and the shell never gets the one it asked for.
 */
export type TaskbarPreviewChannel = 'thumbnail' | 'live-preview'

export type SupplyDecision =
  /** This result describes the newest terminal state and the current window. Use it. */
  | 'accept'
  /** A newer generation has already been supplied on this channel. Dropping this is the law. */
  | 'superseded'
  /** Rasterized for a window incarnation that no longer exists. */
  | 'foreign-incarnation'

export class TaskbarPreviewSupplyLedger {
  /** Generation 0 means "nothing has been observed yet", so a first supply is never superseded. */
  private currentGeneration = 0
  private suppliedByChannel = new Map<TaskbarPreviewChannel, number>()
  private lastInvalidatedAtMs: number | null = null
  private incarnation: TaskbarPreviewIncarnation = Symbol('taskbar-preview-incarnation')

  /** Terminal truth changed. Coalescing is the absence of anything else happening here. */
  advance(): number {
    this.currentGeneration += 1
    return this.currentGeneration
  }

  get generation(): number {
    return this.currentGeneration
  }

  /** The newest generation any channel has been given, which is what staleness is measured against. */
  get suppliedGeneration(): number {
    let newest = 0
    for (const generation of this.suppliedByChannel.values()) {
      newest = Math.max(newest, generation)
    }
    return newest
  }

  suppliedGenerationFor(channel: TaskbarPreviewChannel): number {
    return this.suppliedByChannel.get(channel) ?? 0
  }

  /** True while Windows holds something older than what the terminal now shows. */
  get isStale(): boolean {
    return this.currentGeneration > this.suppliedGeneration
  }

  get currentIncarnation(): TaskbarPreviewIncarnation {
    return this.incarnation
  }

  /**
   * A new native window handle has been adopted.
   *
   * Everything rasterized for the previous one is now foreign, including results already in flight.
   * The supplied generation resets with it: the replacement window has shown the shell nothing yet,
   * so treating the old window's supply as covering it would leave the first demand unanswered.
   */
  adoptIncarnation(): TaskbarPreviewIncarnation {
    this.incarnation = Symbol('taskbar-preview-incarnation')
    this.suppliedByChannel.clear()
    return this.incarnation
  }

  /**
   * Decide whether a finished raster may be handed to Windows, and record it if so.
   *
   * Incarnation is checked before generation on purpose: a result from a destroyed window is wrong
   * regardless of how new its content was, and reporting it as merely superseded would suggest the
   * content was the problem.
   *
   * The generation test is strict: only a raster *older* than what this channel already holds is
   * refused. A raster at the same generation is a fresh answer to a fresh demand, and the shell asks
   * again for reasons that have nothing to do with the terminal — a different surface, a resize, a
   * cache it dropped. Refusing those was a real freeze: the first thumbnail was supplied and every
   * later demand was turned away until a terminal write happened to bump the counter, which for an
   * idle terminal is never. The fence exists to stop a late render walking the picture backwards,
   * not to decide which requests deserve an answer.
   */
  commitSupply(result: {
    generation: number
    incarnation: TaskbarPreviewIncarnation
    channel: TaskbarPreviewChannel
  }): SupplyDecision {
    if (result.incarnation !== this.incarnation) {
      return 'foreign-incarnation'
    }
    if (result.generation < this.suppliedGenerationFor(result.channel)) {
      return 'superseded'
    }
    this.suppliedByChannel.set(result.channel, result.generation)
    return 'accept'
  }

  /**
   * Whether to hint to the shell that its copy is stale.
   *
   * Rate limited because terminal output arrives far faster than the shell will ever redraw a
   * thumbnail, and one hint per byte would be a native call per byte for no visible gain.
   */
  shouldInvalidate(nowMs: number, minIntervalMs: number): boolean {
    if (!this.isStale) {
      return false
    }
    if (this.lastInvalidatedAtMs === null) {
      return true
    }
    return nowMs - this.lastInvalidatedAtMs >= minIntervalMs
  }

  recordInvalidated(nowMs: number): void {
    this.lastInvalidatedAtMs = nowMs
  }
}
