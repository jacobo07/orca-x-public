/** `not-terminated`: the old renderer never reported its exit, so nothing was loaded. */
export type RendererReplacementResult = 'replaced' | 'gone' | 'not-terminated'

/** Measured ~80 ms on Electron 43; the bound only has to outlast a slow machine, not a hung renderer. */
export const RENDERER_REPLACEMENT_EXIT_TIMEOUT_MS = 5_000

type RendererReplacer = () => Promise<RendererReplacementResult>

const replacersByWebContentsId = new Map<number, RendererReplacer>()

/**
 * The window that owns a renderer's crash recovery is the only party that may replace it, because
 * replacing is a deliberate crash that recovery must stand down for. Returns the unregister.
 */
export function registerRendererReplacement(
  webContentsId: number,
  replacer: RendererReplacer
): () => void {
  replacersByWebContentsId.set(webContentsId, replacer)
  return () => {
    if (replacersByWebContentsId.get(webContentsId) === replacer) {
      replacersByWebContentsId.delete(webContentsId)
    }
  }
}

/** `unsupported`: no owner registered, so the caller must not crash the renderer itself. */
export function replaceWindowRenderer(
  webContentsId: number
): Promise<RendererReplacementResult | 'unsupported'> {
  const replacer = replacersByWebContentsId.get(webContentsId)
  return replacer ? replacer() : Promise.resolve('unsupported')
}

/**
 * Replace a window's renderer with a new process: crash it, wait for its exit, then load.
 *
 * Why wait: on Electron 43 `forcefullyCrashRenderer()` followed at once by a reload leaves a window
 * with no renderer at all (pid 0, nothing loads). Reloading after `render-process-gone` brings up a
 * new process in ~100 ms, hung or not. The owner routes that exit here through `claimExit` so its
 * crash recovery neither reloads a second time nor spends a recovery on it.
 */
export function createRendererReplacer(deps: {
  webContentsId: number
  forcefullyCrashRenderer: () => void
  isWindowGone: () => boolean
  load: () => void
  onBeforeReplacement?: (webContentsId: number) => void
  onAbandoned?: (webContentsId: number) => void
}): { replace: RendererReplacer; claimExit: () => boolean } {
  let settleExit: ((exited: boolean) => void) | null = null

  const replace: RendererReplacer = async () => {
    if (deps.isWindowGone()) {
      return 'gone'
    }
    if (settleExit) {
      return 'not-terminated'
    }
    const exited = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), RENDERER_REPLACEMENT_EXIT_TIMEOUT_MS)
      settleExit = (value) => {
        clearTimeout(timer)
        resolve(value)
      }
    })
    deps.onBeforeReplacement?.(deps.webContentsId)
    deps.forcefullyCrashRenderer()
    const didExit = await exited
    settleExit = null
    if (deps.isWindowGone()) {
      return 'gone'
    }
    if (!didExit) {
      // A late exit must reach ordinary recovery, not a replacement that already gave up.
      deps.onAbandoned?.(deps.webContentsId)
      return 'not-terminated'
    }
    deps.load()
    return 'replaced'
  }

  const claimExit = (): boolean => {
    if (!settleExit) {
      return false
    }
    settleExit(true)
    return true
  }

  return { replace, claimExit }
}
