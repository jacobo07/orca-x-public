import { RENDERER_REPLACEMENT_EXIT_TIMEOUT_MS } from './renderer-replacement'
import { createWebContentsTimedFlags } from './web-contents-timed-flags'

/** Outlasts the replacer's own exit wait plus a slow load; a mark that outlived it would hide a crash. */
export const RENDERER_REPLACEMENT_MARK_MS = RENDERER_REPLACEMENT_EXIT_TIMEOUT_MS + 5_000

export type RendererReplacementBreadcrumb =
  | 'renderer_replacement_requested'
  | 'renderer_replacement_abandoned'

export type RendererReplacementHooks = {
  onBeforeRendererReplacement: (webContentsId: number) => void
  onRendererReplacementAbandoned: (webContentsId: number) => void
  /** Read by crash classification: the exit Orca caused is neither reported nor recovered. */
  isRendererReplacementInFlight: (webContentsId: number) => boolean
  /** The replacement renderer loaded, so its own exits are crashes again. */
  settle: (webContentsId: number) => void
}

/**
 * What the app does around a window replacing its renderer. Keyed per window: one window's
 * replacement must not hide another window's crash.
 */
export function createRendererReplacementHooks(deps: {
  spareLivePtysOnNextLoad: (webContentsId: number) => void
  recordBreadcrumb: (name: RendererReplacementBreadcrumb) => void
  showAbandonedNotice: (webContentsId: number) => void
}): RendererReplacementHooks {
  const inFlight = createWebContentsTimedFlags(RENDERER_REPLACEMENT_MARK_MS)
  return {
    onBeforeRendererReplacement: (webContentsId) => {
      inFlight.mark(webContentsId)
      // The new renderer's did-finish-load would otherwise sweep the window's live PTYs as orphans.
      deps.spareLivePtysOnNextLoad(webContentsId)
      deps.recordBreadcrumb('renderer_replacement_requested')
    },
    onRendererReplacementAbandoned: (webContentsId) => {
      inFlight.clear(webContentsId)
      deps.recordBreadcrumb('renderer_replacement_abandoned')
      deps.showAbandonedNotice(webContentsId)
    },
    isRendererReplacementInFlight: (webContentsId) => inFlight.matches(webContentsId),
    settle: (webContentsId) => inFlight.clear(webContentsId)
  }
}
