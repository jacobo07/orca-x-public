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
}

export type TaskbarPreviewDiagnostic =
  | { kind: 'enabled'; hresult: number }
  | { kind: 'demand'; livePreview: boolean; width: number; height: number; generation: number }
  | { kind: 'supplied'; livePreview: boolean; hresult: number; generation: number; rows: number }
  | { kind: 'dropped'; reason: SupplyDecision | 'window-gone' | 'no-size' | 'read-failed' }
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
  theme?: { background?: number; foreground?: number; fontFace?: string }
  now?: () => number
  invalidateIntervalMs?: number
  onDiagnostic?: (event: TaskbarPreviewDiagnostic) => void
}

export type TaskbarPreviewController = {
  /** Opt the window in and begin answering demands. */
  start(): void
  /** Re-resolve the subject; called when the window's active pane may have changed. */
  retarget(): void
  /** Release the hint subscription and hand the window back to DWM's own compositing. */
  dispose(): void
  /** Test seam: the generation ledger this controller fences against. */
  readonly ledger: TaskbarPreviewSupplyLedger
}

/**
 * The shell packs the largest acceptable thumbnail size into lParam: width in the high word, height
 * in the low one. Measured against a real demand (0x00fa0094 for a landscape window => 250x148)
 * rather than taken from prose, because the documentation names the fields and not the order.
 */
export function decodeIconicThumbnailSize(
  lParam: Buffer
): { width: number; height: number } | null {
  if (lParam.length < 4) {
    return null
  }
  const packed = lParam.readUInt32LE(0)
  const width = (packed >>> 16) & 0xff_ff
  const height = packed & 0xff_ff
  return width > 0 && height > 0 ? { width, height } : null
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

  const onOutput = (): void => {
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

    const subject = deps.resolveSubject()
    let lines: readonly string[]
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
    const hresult = deps.addon.drawIconicText(handle, {
      width: size.width,
      height: size.height,
      lines,
      background,
      foreground,
      ...(deps.theme?.fontFace ? { fontFace: deps.theme.fontFace } : {}),
      livePreview
    })
    report({ kind: 'supplied', livePreview, hresult, generation, rows: lines.length })
  }

  const onDemand = (livePreview: boolean, lParam: Buffer): void => {
    if (disposed) {
      return
    }
    const size = livePreview ? contentSize() : decodeIconicThumbnailSize(lParam)
    if (!size) {
      report({ kind: 'dropped', reason: 'no-size' })
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

  const contentSize = (): { width: number; height: number } | null => {
    if (disposed || deps.window.isDestroyed()) {
      return null
    }
    const [width, height] = deps.window.getContentSize()
    return typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0
      ? { width, height }
      : null
  }

  return {
    start(): void {
      const handle = nativeHandle()
      if (!handle) {
        return
      }
      incarnation = ledger.adoptIncarnation()
      const hresult = deps.addon.enableIconicRepresentation(handle, true)
      report({ kind: 'enabled', hresult })

      deps.window.hookWindowMessage(deps.addon.messages.sendIconicThumbnail, (_wParam, lParam) =>
        onDemand(false, lParam)
      )
      deps.window.hookWindowMessage(
        deps.addon.messages.sendIconicLivePreviewBitmap,
        (_wParam, lParam) => onDemand(true, lParam)
      )

      // There is something worth showing before a single new byte arrives, so the first demand must
      // not be refused as superseded.
      ledger.advance()
      retarget()
    },
    retarget,
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
      if (handle) {
        deps.addon.disableIconicRepresentation(handle)
      }
    },
    ledger
  }
}
