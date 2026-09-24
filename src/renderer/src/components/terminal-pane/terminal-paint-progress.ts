/**
 * Whether a terminal's canvas is PAINTING, as distinct from whether its render loop is running.
 *
 * `terminal-render-progress.ts` counts `onRender`, and states its own residual: it detects a render
 * loop that stopped, never one that runs and paints nothing. The Owner's frozen pane came from a
 * build that already carried that fix, so the residual is the live failure, not a theoretical one.
 *
 * This reads the pixels Chromium actually presented, through the same `reachRenderInternals` seam
 * the render-desync sentinel uses. It is a CHANGE oracle, not the sentinel's missing-ink oracle:
 * a stale canvas is fully inked and wrong, so `measureDivergence` is the wrong question for it.
 *
 * Absent means UNKNOWN, never stalled. Four states return null rather than a signature, because in
 * each of them a canvas that does not change is behaving correctly:
 *   - no reachable renderer (the web client, and every terminal fixture)
 *   - the render service is paused
 *   - the viewport is scrolled back, so new output lands off-screen by the user's own choice
 *   - the readback failed
 */
import { activeBuffer, reachRenderInternals } from './terminal-render-desync-frame'

/** Big enough that one changed glyph row survives the downscale, small enough that the readback is
 *  a few hundred KB rather than the multi-megabyte full canvas. */
const SIGNATURE_MAX_DIMENSION = 256

let signatureCanvas: HTMLCanvasElement | null = null
let signatureContext: CanvasRenderingContext2D | null = null

type ScrollableBuffer = { viewportY: number; baseY?: number }

/** Test seam: happy-dom has no 2D canvas, so unit fixtures inject their own painted state. */
let sampler: (terminal: object) => string | null = sampleFromPresentedCanvas

export function captureTerminalPaintSignature(terminal: object): string | null {
  try {
    return sampler(terminal)
  } catch {
    // Why swallowed: paint liveness is a diagnostic lane. A renderer that refuses readback must
    // degrade to unknown -- which is never a stall -- not take down the watchdog tick.
    return null
  }
}

function sampleFromPresentedCanvas(terminal: object): string | null {
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
  sampler = sampleFromPresentedCanvas
  releaseTerminalPaintSignatureReadback()
}
