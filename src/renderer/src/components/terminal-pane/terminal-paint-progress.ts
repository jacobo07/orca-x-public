/**
 * Whether a terminal's canvas is PAINTING, as distinct from whether its render loop is running.
 *
 * `terminal-render-progress.ts` counts `onRender`, and states its own residual: it detects a render
 * loop that stopped, never one that runs and paints nothing. The Owner's frozen pane came from a
 * build that already carried that fix, so the residual is the live failure, not a theoretical one.
 *
 * This hashes the pixels the renderer drew, through the same `reachRenderInternals` seam the
 * render-desync sentinel uses. It is a CHANGE oracle, not the sentinel's missing-ink oracle: a stale
 * canvas is fully inked and wrong, so `measureDivergence` is the wrong question for it.
 *
 * WHEN it reads is the whole design. Orca creates the WebGL addon without `preserveDrawingBuffer`,
 * so outside the task that drew a frame the drawing buffer reads back cleared, and every pane hashes
 * the same. A first version read on the watchdog tick and would have flagged every healthy pane;
 * the real-app control caught it. So a sample is ARMED per tick and taken synchronously inside the
 * next `onRender` callback, which xterm fires in the same task as the draw. A render that painted
 * nothing then reads back cleared on every armed frame, which is exactly a signature that stops
 * changing.
 *
 * Absent means UNKNOWN, never stalled. The sampler returns null when not painting is correct or the
 * read is impossible: no reachable renderer (the web client, and every terminal fixture), a paused
 * render service, a viewport the user scrolled back, or a failed readback.
 */
import { activeBuffer, reachRenderInternals } from './terminal-render-desync-frame'

/** Big enough that one changed glyph row survives the downscale, small enough that the readback is
 *  a few hundred KB rather than the multi-megabyte full canvas. */
const SIGNATURE_MAX_DIMENSION = 256

type ScrollableBuffer = { viewportY: number; baseY?: number }

let signatureCanvas: HTMLCanvasElement | null = null
let signatureContext: CanvasRenderingContext2D | null = null

const armedTerminals = new WeakSet<object>()
/** A sample taken since the last take. Present-but-null means "a frame rendered and was unjudgeable". */
const samplesByTerminal = new WeakMap<object, string | null>()

/** Test seam: happy-dom has no 2D canvas, so unit fixtures inject their own painted state. */
let sampler: (terminal: object) => string | null = sampleDrawnFrame

/**
 * Start sampling this terminal. Arms immediately, so the first judgement already has a baseline.
 * Frames reach `recordTerminalFrameDrawn` through the render-progress subscription; a terminal with
 * no `onRender` never calls it, so every take returns null and it is never judged.
 */
export function startTerminalPaintObservation(terminal: object): () => void {
  armedTerminals.add(terminal)
  return () => {
    armedTerminals.delete(terminal)
    samplesByTerminal.delete(terminal)
  }
}

/** Called inside the render callback — the task that drew the frame, where the drawing buffer is
 *  still readable. Reads only when a judgement armed it, so there is one readback per tick. */
export function recordTerminalFrameDrawn(terminal: object): void {
  if (!armedTerminals.has(terminal)) {
    return
  }
  armedTerminals.delete(terminal)
  samplesByTerminal.set(terminal, safeSample(terminal))
}

/** The signature read since the previous take, or null when no judgeable frame rendered in between.
 *  Re-arms, so exactly one readback happens per judgement. */
export function takeTerminalPaintSample(terminal: object): string | null {
  const sample = samplesByTerminal.get(terminal) ?? null
  samplesByTerminal.delete(terminal)
  armedTerminals.add(terminal)
  return sample
}

function safeSample(terminal: object): string | null {
  try {
    return sampler(terminal)
  } catch {
    // Why swallowed: a renderer that refuses readback degrades to unknown, which is never a stall.
    return null
  }
}

function sampleDrawnFrame(terminal: object): string | null {
  const internals = reachRenderInternals(terminal)
  if (!internals || internals.isPaused) {
    return null
  }
  const buffer = activeBuffer(terminal) as ScrollableBuffer | null
  // Why: a user scrolled off the bottom is asking for a stationary viewport. New output arrives in
  // the buffer and correctly changes nothing on screen, which is indistinguishable from a freeze.
  if (buffer && typeof buffer.baseY === 'number' && buffer.viewportY !== buffer.baseY) {
    return null
  }
  const { canvas } = internals
  if (!canvas.width || !canvas.height) {
    return null
  }
  const scale = Math.min(1, SIGNATURE_MAX_DIMENSION / Math.max(canvas.width, canvas.height))
  const width = Math.max(1, Math.round(canvas.width * scale))
  const height = Math.max(1, Math.round(canvas.height * scale))
  const context = getSignatureContext(width, height)
  if (!context) {
    return null
  }
  context.clearRect(0, 0, width, height)
  context.drawImage(canvas, 0, 0, width, height)
  return hashPixels(context.getImageData(0, 0, width, height).data, canvas.width, canvas.height)
}

function getSignatureContext(width: number, height: number): CanvasRenderingContext2D | null {
  if (!signatureCanvas) {
    signatureCanvas = document.createElement('canvas')
    signatureContext = null
  }
  if (signatureCanvas.width !== width || signatureCanvas.height !== height) {
    signatureCanvas.width = width
    signatureCanvas.height = height
    signatureContext = null
  }
  signatureContext ??= signatureCanvas.getContext('2d', { willReadFrequently: true })
  return signatureContext
}

/** FNV-1a over the downscaled frame. Source dimensions are folded in so a resize reads as a change
 *  rather than as a pane that stopped painting. */
function hashPixels(pixels: Uint8ClampedArray, sourceWidth: number, sourceHeight: number): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < pixels.length; i++) {
    hash ^= pixels[i]
    hash = Math.imul(hash, 0x01000193)
  }
  return `${sourceWidth}x${sourceHeight}:${(hash >>> 0).toString(36)}`
}

export function releaseTerminalPaintSignatureReadback(): void {
  if (signatureCanvas) {
    signatureCanvas.width = 0
    signatureCanvas.height = 0
  }
  signatureCanvas = null
  signatureContext = null
}

export function _setTerminalPaintSamplerForTests(fn: (terminal: object) => string | null): void {
  sampler = fn
}

export function _resetTerminalPaintProgressForTests(): void {
  sampler = sampleDrawnFrame
  releaseTerminalPaintSignatureReadback()
}
