/**
 * Keeping a minimized window's taskbar thumbnail current when nothing in the terminal moves.
 *
 * The controller's staleness signal is terminal output, and its subject is ONE pty — the active
 * pane of the active tab. The picture it supplies has been the whole window since the renderer
 * started rendering it. Those are different subjects, and the gap is a real defect: an agent panel
 * streaming, a diff opening, a second pane's output, or any view that is not that terminal all
 * change the window and invalidate nothing. The thumbnail then holds whatever was captured when the
 * pane last wrote — for an idle pane, the moment of minimize, indefinitely.
 *
 * So freshness gets a floor whose subject is the window itself. What keeps that from being a
 * permanent capture loop is the demand test below.
 */

/**
 * How often a minimized window offers the shell a newer picture of itself.
 *
 * Chosen against what a person reading a preview perceives as moving rather than against any frame
 * rate: two and a half captures a second at the very most, and only while a preview is on screen.
 */
export const MINIMIZED_REFRESH_INTERVAL_MS = 400

/**
 * How long after a demand the shell is still assumed to be displaying the thumbnail.
 *
 * DWM asks for a bitmap when it needs to paint one, so a recent demand is the only evidence
 * reachable from inside this process that anyone is looking. Without this test the ticker sustains
 * itself — invalidate, DWM asks, the ask looks recent, invalidate again — and captures the window
 * forever behind a flyout that closed. Sized at several ticks so an ordinary gap between repaints
 * does not read as the user having looked away.
 */
export const DEMAND_CONSIDERED_LIVE_MS = 2_000

/** Unref'd: a thumbnail must never be the reason a process refuses to exit. */
function defaultSchedule(tick: () => void, intervalMs: number): () => void {
  const handle = setInterval(tick, intervalMs)
  handle.unref?.()
  return () => clearInterval(handle)
}

export type TaskbarPreviewRefreshTicker = {
  /** The shell asked for a bitmap, which is what makes the next few ticks worth taking. */
  recordDemand(): void
  /** Begin ticking. Idempotent, so a repeated minimize edge costs nothing. */
  arm(): void
  /** Stop ticking. Idempotent, and safe to call on a ticker that was never armed. */
  disarm(): void
  /** Test seam: whether a tick is currently scheduled. */
  readonly armed: boolean
}

export function createTaskbarPreviewRefreshTicker(options: {
  /** Invoked when the picture should be treated as out of date. */
  onStale: () => void
  now: () => number
  schedule?: (tick: () => void, intervalMs: number) => () => void
  intervalMs?: number
  demandConsideredLiveMs?: number
}): TaskbarPreviewRefreshTicker {
  const schedule = options.schedule ?? defaultSchedule
  const intervalMs = options.intervalMs ?? MINIMIZED_REFRESH_INTERVAL_MS
  const liveMs = options.demandConsideredLiveMs ?? DEMAND_CONSIDERED_LIVE_MS

  let lastDemandAtMs: number | null = null
  let stop: (() => void) | null = null

  const tick = (): void => {
    // Null rather than 0: a shell that has never asked is not a shell that asked at the epoch, and
    // treating the two alike would invalidate against a preview nobody has ever displayed.
    if (lastDemandAtMs === null || options.now() - lastDemandAtMs > liveMs) {
      return
    }
    options.onStale()
  }

  return {
    recordDemand(): void {
      lastDemandAtMs = options.now()
    },
    arm(): void {
      stop ??= schedule(tick, intervalMs)
    },
    disarm(): void {
      stop?.()
      stop = null
    },
    get armed(): boolean {
      return stop !== null
    }
  }
}
