/**
 * Paints the frame the window showed just before a deliberate reload, so the reload reads as one
 * step: your app, still, and then your app, live.
 *
 * Why it lives outside React: the whole point is to be on screen before the app shell mounts, and
 * the shell is what it exists to hide. A React overlay would render on the same pass as the empty
 * shell it is covering, and would be unmounted by the very remount it is meant to smooth over.
 *
 * It can never outlive its reload — it goes away on hydration, on a resize that invalidates it, and
 * on an absolute cap if hydration never finishes at all.
 */
import type { ReloadFreezeFrame } from '../../../shared/reload-freeze-frame'

const OVERLAY_ID = 'orca-reload-freeze-frame'
/** Backstop: a failed or stalled hydration must not leave a still picture of the app on screen. */
const MAX_VISIBLE_MS = 8_000
const FADE_MS = 160

let overlay: HTMLElement | null = null
/** Set once the app declares itself ready, so a frame still decoding is never shown afterwards. */
let appReady = false
let capTimer: ReturnType<typeof setTimeout> | undefined
let removeTimer: ReturnType<typeof setTimeout> | undefined
let onResize: (() => void) | undefined

function teardownWatchers(): void {
  if (capTimer) {
    clearTimeout(capTimer)
    capTimer = undefined
  }
  if (onResize) {
    window.removeEventListener('resize', onResize)
    onResize = undefined
  }
}

/** Take down the frozen frame and hand the window back to the live app. */
export function dismissReloadFreezeFrame(): void {
  teardownWatchers()
  const element = overlay
  overlay = null
  if (!element) {
    return
  }
  // Never keep swallowing input while fading — the app underneath is ready by now.
  element.style.pointerEvents = 'none'
  element.style.opacity = '0'
  removeTimer = setTimeout(() => {
    element.remove()
    removeTimer = undefined
  }, FADE_MS)
}

function buildOverlay(image: HTMLImageElement): HTMLElement {
  const element = document.createElement('div')
  element.id = OVERLAY_ID
  element.setAttribute('aria-hidden', 'true')
  // Inline styles rather than a class: the stylesheet is not guaranteed to have been applied yet,
  // and an unstyled full-screen div would be exactly the flash this removes.
  element.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:2147483647',
    `transition:opacity ${FADE_MS}ms ease-out`,
    'opacity:1',
    // Swallows clicks aimed at an app shell that is not hydrated yet.
    'pointer-events:auto',
    'will-change:opacity'
  ].join(';')
  image.style.cssText = 'width:100%;height:100%;display:block;object-fit:fill'
  element.appendChild(image)
  return element
}

/**
 * Ask main whether this load is the far side of a reload, and if so paint that reload's last frame.
 *
 * Resolves to whether a frame was shown. Never rejects: on a cold start, a crash recovery, the web
 * runtime, or any failure, the answer is simply no frame and today's behaviour.
 */
export async function showReloadFreezeFrameIfPresent(): Promise<boolean> {
  const take = window.api?.app?.takeReloadFreezeFrame
  if (typeof take !== 'function') {
    return false
  }

  let frame: ReloadFreezeFrame | null = null
  try {
    frame = await take()
  } catch {
    return false
  }
  if (!frame?.dataUrl || !document.body) {
    return false
  }

  const image = new Image()
  image.src = frame.dataUrl
  try {
    // Decoded before it is attached, so the first painted overlay frame is the picture itself
    // rather than an empty box over the app.
    await image.decode()
  } catch {
    return false
  }

  // Hydration can win the race on a warm reload; showing the frame then would be a flash in reverse.
  if (appReady) {
    return false
  }

  overlay = buildOverlay(image)
  document.body.appendChild(overlay)

  capTimer = setTimeout(dismissReloadFreezeFrame, MAX_VISIBLE_MS)
  onResize = () => {
    // A frame captured at the old size is no longer a picture of this window. An honest empty shell
    // beats a stretched one.
    dismissReloadFreezeFrame()
  }
  window.addEventListener('resize', onResize)
  return true
}

/** Called by the hydration chain; safe before, during or after the frame is shown. */
export function reportAppReadyForFreezeFrame(): void {
  appReady = true
  if (!overlay || typeof requestAnimationFrame !== 'function') {
    dismissReloadFreezeFrame()
    return
  }
  // Two frames: the store was mutated synchronously, so React has not painted the hydrated shell
  // yet. Uncovering now would reveal one last empty frame — the jump this exists to hide.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      dismissReloadFreezeFrame()
    })
  })
}

/** Test seam: module state outlives any single overlay. */
export function resetReloadFreezeFrameOverlayForTest(): void {
  teardownWatchers()
  if (removeTimer) {
    clearTimeout(removeTimer)
    removeTimer = undefined
  }
  overlay?.remove()
  overlay = null
  appReady = false
  document.getElementById(OVERLAY_ID)?.remove()
}

export const RELOAD_FREEZE_FRAME_OVERLAY_ID = OVERLAY_ID
export const RELOAD_FREEZE_FRAME_MAX_VISIBLE_MS = MAX_VISIBLE_MS
