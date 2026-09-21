/**
 * One window's taskbar thumbnail, from DWM's demand to the pixels that answer it.
 *
 * The whole surface is an observer. It reads the headless terminal the hover preview already reads,
 * and it has no route to the things that would make it a participant: it never resizes a PTY, never
 * routes input, never takes focus, never claims a grid, and never acknowledges output. In
 * particular the size Windows asks for constrains only the bitmap handed back to Windows — a 250x148
 * thumbnail request must not become a 250-column terminal.
 *
 * Rasterizing happens after the window procedure returns, which DWM allows and which is what keeps
 * the message path cheap. Everything that can go wrong with that lives in the supply ledger: results
 * are fenced by the window incarnation they were drawn for and the generation of terminal truth they
 * were drawn from, and a burst of output produces one more render rather than a queue of them.
 *
 * Nothing here logs terminal content. A thumbnail is made of whatever is on the user's screen,
 * which routinely includes secrets, so diagnostics carry sizes, decisions and reasons only.
 */
import { describeUnavailableSubject, selectThumbnailLines } from './taskbar-preview-content'
import type { TaskbarPreviewNativeAddon } from './taskbar-preview-native'
import type { TaskbarPreviewSubject } from './taskbar-preview-subject'
import { decodeIconicThumbnailSize, resolveLivePreviewSize } from './taskbar-preview-bitmap-size'
import { createTaskbarPreviewRefreshTicker } from './taskbar-preview-refresh-ticker'
import {
  TaskbarPreviewSupplyLedger,
  type SupplyDecision,
  type TaskbarPreviewIncarnation
} from './taskbar-preview-supply-ledger'

/** Terminal-ish defaults; the wiring passes the real theme where one is available. */
const DEFAULT_BACKGROUND = 0x11_11_11
const DEFAULT_FOREGROUND = 0xd4_d4_d4

/**
 * How often the shell may be told its copy is stale.
 *
 * Terminal output arrives orders of magnitude faster than any shell redraws a thumbnail, so this is
 * a floor on native calls rather than a limit on freshness: every demand is always answered from the
 * newest generation regardless of how many hints were skipped.
 */
export const DEFAULT_INVALIDATE_INTERVAL_MS = 250

export type TaskbarPreviewMessageWindow = {
  hookWindowMessage(message: number, callback: (wParam: Buffer, lParam: Buffer) => void): void
  getNativeWindowHandle(): Buffer
  isDestroyed(): boolean
  /** Used for the Peek bitmap, which is window-sized rather than thumbnail-sized. */
  getContentSize(): number[]
  /** Fallback geometry: a minimized window may report no content size, and that is when it is asked. */
  getBounds?(): { width: number; height: number }
  /**
   * Whether the window is already minimized when the preview attaches.
   *
   * A window restored from a minimized topology is in the state the thumbnail is for, and its
   * minimize edge happened before anything here was listening — so the posture cannot be decided by
   * the edge alone. Optional: a host that cannot answer is treated as visible, which is the posture
   * that changes nothing.
   */
  isMinimized?(): boolean
}

export type TaskbarPreviewDiagnostic =
  /** The takeover is engaged: DWM now serves what this window supplies instead of compositing it. */
  | { kind: 'enabled'; hresult: number }
  /**
   * The takeover is released and DWM composites the window itself again.
   *
   * Its own kind rather than an `enabled` with a flag, because the two are opposite postures and a
   * log that cannot tell them apart cannot answer the only question worth asking of this feature:
   * which surface was the user actually shown.
   */
  | { kind: 'released'; hresult: number }
  | { kind: 'demand'; livePreview: boolean; width: number; height: number; generation: number }
  | {
      kind: 'supplied'
      livePreview: boolean
      hresult: number
      generation: number
      rows: number
      /**
       * Which of the two renderers answered. Worth recording because they look completely different
       * on screen, and "supplied, hresult 0" is identical for both — so without this the diagnostics
       * cannot distinguish a real picture of the window from the fallback that replaced it.
       */
      source: 'window' | 'text'
    }
  | {
      kind: 'dropped'
      reason: SupplyDecision | 'window-gone' | 'no-size' | 'read-failed'
      /** Which channel the drop belongs to; absent when the drop is not attributable to one. */
      livePreview?: boolean
    }
  | { kind: 'invalidated'; hresult: number; generation: number }

export type TaskbarPreviewControllerDeps = {
  window: TaskbarPreviewMessageWindow
  addon: TaskbarPreviewNativeAddon
  /** The canonical window -> workspace -> tab -> pane -> pty answer, re-asked at every demand. */
  resolveSubject: () => TaskbarPreviewSubject
  /** The headless terminal's visible rows. Null means unreadable, which is not an empty screen. */
  readViewportLines: (ptyId: string) => Promise<readonly string[] | null>
  /** Fires when the subject produced output. Carries no data: this surface wants state, not bytes. */
  subscribeToTerminalOutput: (ptyId: string, onOutput: () => void) => () => void
  /**
   * A real rendering of the window, at most the requested size, as BGRA top-down pixels.
   *
   * Null means no frame could be captured, which is a normal state rather than a failure — and the
   * text rasterizer answers instead. Optional so a caller that cannot capture keeps the old
   * behaviour rather than losing its thumbnail.
   */
  captureWindowImage?: (size: {
    width: number
    height: number
  }) => Promise<{ width: number; height: number; pixels: Buffer } | null>
  theme?: { background?: number; foreground?: number; fontFace?: string }
  now?: () => number
  invalidateIntervalMs?: number
  /**
   * Arms a repeating tick and returns the call that stops it.
   *
   * A seam rather than a direct `setInterval` so the refresh behaviour can be driven a tick at a
   * time against the same manual clock the rest of this controller is tested with. The default
   * unrefs, because a thumbnail must never be the reason a process refuses to exit.
   */
  scheduleRefresh?: (tick: () => void, intervalMs: number) => () => void
  refreshIntervalMs?: number
  onDiagnostic?: (event: TaskbarPreviewDiagnostic) => void
}

export type TaskbarPreviewController = {
  /** Opt the window in and begin answering demands. */
  start(): void
  /** Re-resolve the subject; called when the window's active pane may have changed. */
  retarget(): void
  /**
   * Engage the takeover while the window is minimized, release it when it is not.
   *
   * Scoped rather than held for the window's lifetime because forcing the iconic representation
   * REPLACES DWM's own composition of the window with a bitmap capped at the size the shell asked
   * for. While the window is visible that trade buys nothing and costs resolution, so the default
   * posture is the platform's.
   */
  setWindowMinimized(minimized: boolean): void
  /** Release the hint subscription and hand the window back to DWM's own compositing. */
  dispose(): void
  /** Test seam: the generation ledger this controller fences against. */
  readonly ledger: TaskbarPreviewSupplyLedger
}

export function createTaskbarPreviewController(
  deps: TaskbarPreviewControllerDeps
): TaskbarPreviewController {
  const ledger = new TaskbarPreviewSupplyLedger()
  const now = deps.now ?? (() => Date.now())
  const invalidateIntervalMs = deps.invalidateIntervalMs ?? DEFAULT_INVALIDATE_INTERVAL_MS
  const background = deps.theme?.background ?? DEFAULT_BACKGROUND
  const foreground = deps.theme?.foreground ?? DEFAULT_FOREGROUND

  let disposed = false
  let incarnation: TaskbarPreviewIncarnation = ledger.currentIncarnation
  let subscribedPtyId: string | null = null
  let unsubscribe: (() => void) | null = null

  const report = (event: TaskbarPreviewDiagnostic): void => deps.onDiagnostic?.(event)

  /**
   * A handle is only valid while the window is alive, and reading it from a destroyed window throws.
   * Every native call goes through here so a closing window degrades to "no thumbnail" rather than
   * to an exception on the message path.
   */
  const nativeHandle = (): Buffer | null => {
    if (disposed || deps.window.isDestroyed()) {
      return null
    }
    try {
      return deps.window.getNativeWindowHandle()
    } catch {
      return null
    }
  }

  const releaseSubscription = (): void => {
    unsubscribe?.()
    unsubscribe = null
    subscribedPtyId = null
  }

  /**
   * The window-subject freshness floor, armed only while the takeover is engaged.
   *
   * `hintStale` is referenced lazily because it is declared below; the ticker cannot fire before
   * this function has finished building the controller.
   */
  const refresh = createTaskbarPreviewRefreshTicker({
    onStale: () => hintStale(),
    now,
    ...(deps.scheduleRefresh ? { schedule: deps.scheduleRefresh } : {}),
    ...(deps.refreshIntervalMs === undefined ? {} : { intervalMs: deps.refreshIntervalMs })
  })

  /**
   * Declare the shell's copy out of date and, if the rate limit allows, tell it so.
   *
   * Shared by both things that can make the picture stale: bytes arriving in the subject terminal,
   * and time passing while a minimized window is on display. They differ only in what prompted
   * them — the generation, the fence and the rate limit are the same machinery either way.
   */
  const hintStale = (): void => {
    if (disposed) {
      return
    }
    ledger.advance()
    const at = now()
    if (!ledger.shouldInvalidate(at, invalidateIntervalMs)) {
      return
    }
    const handle = nativeHandle()
    if (!handle) {
      return
    }
    // Advisory by contract: this tells the shell its copy is old, and the shell decides when — or
    // whether — to ask for a new one. A success here is not a frame the user saw.
    const hresult = deps.addon.invalidateIconicBitmaps(handle)
    ledger.recordInvalidated(at)
    report({ kind: 'invalidated', hresult, generation: ledger.generation })
  }

  const onOutput = (): void => hintStale()

  const retarget = (): void => {
    if (disposed) {
      return
    }
    const subject = deps.resolveSubject()
    const ptyId = subject.status === 'available' ? subject.ptyId : null
    if (ptyId === subscribedPtyId) {
      return
    }
    releaseSubscription()
    // A changed subject changes what the thumbnail should show even though no byte was written, so
    // it advances the generation too. Without this the new terminal's first render reads as
    // superseded and the taskbar keeps showing the pane the user navigated away from.
    ledger.advance()
    if (ptyId) {
      subscribedPtyId = ptyId
      unsubscribe = deps.subscribeToTerminalOutput(ptyId, onOutput)
    }
  }

  const answer = async (livePreview: boolean, size: { width: number; height: number }) => {
    // Captured before any await, and deliberately conservative: this is the newest generation the
    // eventual bitmap is *guaranteed* to describe. Reading it after the await would claim credit for
    // output that landed while the read was in flight — which overstates freshness, and freshness is
    // the number this whole surface is judged on.
    const generation = ledger.generation
    const drawnFor = incarnation

    // A real rendering of the window first. Drawn text can only ever be two colours and one font,
    // which is legible but looks nothing like Orca — and looking like the window is the whole point
    // of a window thumbnail. Windows' own thumbnail gets this right for free precisely because it is
    // the window; forcing the iconic representation is what took that away, so this gives it back.
    const frame = deps.captureWindowImage ? await deps.captureWindowImage(size) : null

    let lines: readonly string[] = []
    if (!frame) {
      const subject = deps.resolveSubject()
      if (subject.status === 'available') {
        const viewport = await deps.readViewportLines(subject.ptyId)
        if (viewport === null) {
          report({ kind: 'dropped', reason: 'read-failed' })
          return
        }
        lines = selectThumbnailLines({
          viewportLines: viewport,
          requestedHeight: size.height
        }).lines
      } else {
        // Words, not a blank frame: "starting" and "closed" are opposite advice, and an empty
        // rectangle is also what a broken feature looks like.
        lines = describeUnavailableSubject(subject.reason)
      }
    }

    const decision = ledger.commitSupply({
      generation,
      incarnation: drawnFor,
      // Two independent bitmaps at two different sizes. Fencing them together meant answering the
      // taskbar thumbnail marked the window-sized live preview as already satisfied, so Peek was
      // never supplied at all.
      channel: livePreview ? 'live-preview' : 'thumbnail'
    })
    if (decision !== 'accept') {
      report({ kind: 'dropped', reason: decision })
      return
    }
    const handle = nativeHandle()
    if (!handle) {
      report({ kind: 'dropped', reason: 'window-gone' })
      return
    }
    if (frame) {
      // The frame reports its OWN dimensions rather than echoing the request: it was resized to fit,
      // and the addon refuses a buffer whose length disagrees with the size beside it. Echoing the
      // request here would turn a rounding difference into a refused frame, or a corrupt one.
      const captured = deps.addon.drawIconicBitmap(handle, {
        width: frame.width,
        height: frame.height,
        pixels: frame.pixels,
        livePreview
      })
      report({
        kind: 'supplied',
        livePreview,
        hresult: captured,
        generation,
        rows: 0,
        source: 'window'
      })
      return
    }

    const hresult = deps.addon.drawIconicText(handle, {
      width: size.width,
      height: size.height,
      lines,
      background,
      foreground,
      ...(deps.theme?.fontFace ? { fontFace: deps.theme.fontFace } : {}),
      livePreview
    })
    report({
      kind: 'supplied',
      livePreview,
      hresult,
      generation,
      rows: lines.length,
      source: 'text'
    })
  }

  const onDemand = (livePreview: boolean, lParam: Buffer): void => {
    if (disposed) {
      return
    }
    // Recorded before anything can reject the demand. A demand the shell made and this controller
    // then failed to size is still evidence that the shell is displaying the preview, and that is
    // the only question this timestamp answers.
    refresh.recordDemand()
    const size = livePreview ? contentSize() : decodeIconicThumbnailSize(lParam)
    if (!size) {
      // Which channel could not be sized is the whole diagnostic: a thumbnail whose lParam decoded
      // to nothing and a live preview whose window would not report its geometry are different
      // faults with different fixes, and one reason string told them apart from neither.
      report({ kind: 'dropped', reason: 'no-size', livePreview })
      return
    }
    report({
      kind: 'demand',
      livePreview,
      width: size.width,
      height: size.height,
      generation: ledger.generation
    })
    // Deliberately not awaited on the message path. DWM accepts a late answer, so the window
    // procedure returns immediately and the raster runs on its own.
    void answer(livePreview, size).catch(() => {
      // An observer that throws must not become a subject failure: the window, its terminals and
      // its agents are unaffected by a thumbnail that could not be drawn.
      report({ kind: 'dropped', reason: 'read-failed' })
    })
  }

  /** Null only for a window that is going away; the sizing itself always has an answer. */
  const contentSize = (): { width: number; height: number } | null =>
    disposed || deps.window.isDestroyed() ? null : resolveLivePreviewSize(deps.window)

  /**
   * The posture the window is currently in, mirrored so a repeated edge costs nothing.
   *
   * Electron emits `restore` for windows that were never minimized, and `minimize` can arrive more
   * than once; a DwmSetWindowAttribute pair per event would be native work for no change of state.
   */
  let minimized = false

  const setWindowMinimized = (next: boolean): void => {
    if (disposed || next === minimized) {
      return
    }
    const handle = nativeHandle()
    if (!handle) {
      return
    }
    minimized = next
    if (next) {
      // HAS_ICONIC_BITMAP and FORCE_ICONIC_REPRESENTATION together: from here DWM asks this window
      // for its thumbnail instead of compositing a surface it can no longer see. That is the one
      // state in which a supplied bitmap beats the platform's own answer, because the platform's
      // answer here is frozen at the moment of minimize.
      report({ kind: 'enabled', hresult: deps.addon.enableIconicRepresentation(handle, true) })
      // Armed with the takeover and released with it, so the cost exists only in the state that
      // buys something. A visible window is composited by DWM and needs no help staying current.
      refresh.arm()
      return
    }
    refresh.disarm()
    // Both attributes cleared, which is what hands the window back. DWM's composition of a visible
    // window is live, full-resolution and free; a supplied bitmap is capped at the size the shell
    // asked for and can therefore never be sharper than the thing it replaced.
    report({ kind: 'released', hresult: deps.addon.disableIconicRepresentation(handle) })
  }

  return {
    start(): void {
      const handle = nativeHandle()
      if (!handle) {
        return
      }
      incarnation = ledger.adoptIncarnation()

      // Hooked before the posture is decided, because the hooks are how a demand arrives: a window
      // that attaches already minimized has to be able to answer the one that follows immediately.
      deps.window.hookWindowMessage(deps.addon.messages.sendIconicThumbnail, (_wParam, lParam) =>
        onDemand(false, lParam)
      )
      deps.window.hookWindowMessage(
        deps.addon.messages.sendIconicLivePreviewBitmap,
        (_wParam, lParam) => onDemand(true, lParam)
      )

      setWindowMinimized(deps.window.isMinimized?.() ?? false)

      // There is something worth showing before a single new byte arrives, so the first demand must
      // not be refused as superseded.
      ledger.advance()
      retarget()
    },
    retarget,
    setWindowMinimized,
    dispose(): void {
      if (disposed) {
        return
      }
      // Read the handle before the disposed flag closes that path: on an ordinary teardown the
      // window is still alive, and leaving it forced-iconic freezes its thumbnail at whatever was
      // last supplied — a picture of a terminal nobody is running any more.
      const handle = nativeHandle()
      disposed = true
      releaseSubscription()
      // A ticker outliving its window would capture a destroyed one every interval, and the handle
      // guard would quietly turn each attempt into a dropped supply rather than anything anyone sees.
      refresh.disarm()
      if (handle) {
        deps.addon.disableIconicRepresentation(handle)
      }
    },
    ledger
  }
}
