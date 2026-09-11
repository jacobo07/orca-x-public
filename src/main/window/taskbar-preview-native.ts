/**
 * Loading the Windows taskbar-preview addon, and surviving its absence.
 *
 * The addon is an enhancement: without it Orca starts, terminals run, agents run, windows behave.
 * Only the live taskbar thumbnail is unavailable. So every failure here resolves to a named
 * unavailable reason rather than a throw — but the reasons stay distinct, because "this is not
 * Windows" and "the packaged build shipped without its addon" need very different responses from
 * whoever reads the diagnostic.
 *
 * No electron import on purpose: path facts are passed in, which keeps this unit testable and keeps
 * the resolution rule visible in one place instead of spread across a packaged branch and a dev one.
 */
import { createRequire } from 'node:module'

export const TASKBAR_PREVIEW_ADDON_FILENAME = 'orca_taskbar_preview.node'
/** Where packaging puts the addon, relative to the packaged resources directory. */
export const TASKBAR_PREVIEW_PACKAGED_DIRNAME = 'taskbar-preview'

export type TaskbarPreviewNativeAddon = {
  /** The two demand messages, exported by the addon so both halves cannot disagree about them. */
  messages: {
    sendIconicThumbnail: number
    sendIconicLivePreviewBitmap: number
  }
  /** Opt a window into supplying its own iconic representation. Returns an HRESULT. */
  enableIconicRepresentation(nativeWindowHandle: Buffer, forceIconic?: boolean): number
  /** Hand the window back to DWM's own compositing. Returns an HRESULT. */
  disableIconicRepresentation(nativeWindowHandle: Buffer): number
  /** Advisory hint that the held representation is stale. Returns an HRESULT. */
  invalidateIconicBitmaps(nativeWindowHandle: Buffer): number
  /** Rasterize `lines` at the requested size and supply the result. Returns an HRESULT. */
  drawIconicText(
    nativeWindowHandle: Buffer,
    request: {
      width: number
      height: number
      lines: readonly string[]
      /** 0xRRGGBB, matching how a theme token reads. */
      background?: number
      foreground?: number
      fontFace?: string
      livePreview?: boolean
    }
  ): number
}

export type TaskbarPreviewNativeUnavailableReason =
  /** DWM iconic representation is a Windows capability; nothing is wrong on other platforms. */
  | 'not-windows'
  /** The addon was never compiled here — the ordinary state of a checkout without MSVC. */
  | 'not-built'
  /** The file exists and the runtime refused it: wrong architecture, missing dependency, corrupt. */
  | 'load-failed'
  /** The module loaded but does not expose the surface this build expects. */
  | 'incompatible'

export type TaskbarPreviewNativeLoad =
  | { status: 'available'; addon: TaskbarPreviewNativeAddon; path: string }
  | { status: 'unavailable'; reason: TaskbarPreviewNativeUnavailableReason; detail?: string }

export type TaskbarPreviewNativeLocation = {
  platform: NodeJS.Platform
  isPackaged: boolean
  /** `process.resourcesPath` in a packaged app. */
  resourcesPath: string
  /** The repository root in development. */
  projectRoot: string
  join: (...segments: string[]) => string
  fileExists: (path: string) => boolean
}

export function resolveTaskbarPreviewAddonPath(location: TaskbarPreviewNativeLocation): string {
  return location.isPackaged
    ? location.join(
        location.resourcesPath,
        TASKBAR_PREVIEW_PACKAGED_DIRNAME,
        TASKBAR_PREVIEW_ADDON_FILENAME
      )
    : location.join(
        location.projectRoot,
        'native',
        'orca-taskbar-preview',
        'build',
        'Release',
        TASKBAR_PREVIEW_ADDON_FILENAME
      )
}

function hasExpectedSurface(candidate: unknown): candidate is TaskbarPreviewNativeAddon {
  if (typeof candidate !== 'object' || candidate === null) {
    return false
  }
  const addon = candidate as Partial<TaskbarPreviewNativeAddon>
  return (
    typeof addon.enableIconicRepresentation === 'function' &&
    typeof addon.disableIconicRepresentation === 'function' &&
    typeof addon.invalidateIconicBitmaps === 'function' &&
    typeof addon.drawIconicText === 'function' &&
    typeof addon.messages?.sendIconicThumbnail === 'number' &&
    typeof addon.messages?.sendIconicLivePreviewBitmap === 'number'
  )
}

export function loadTaskbarPreviewNative(
  location: TaskbarPreviewNativeLocation,
  /** Seam for tests; production loads the real binary through Node's own resolver. */
  loadModule: (path: string) => unknown = (path) => createRequire(path)(path)
): TaskbarPreviewNativeLoad {
  if (location.platform !== 'win32') {
    return { status: 'unavailable', reason: 'not-windows' }
  }

  const path = resolveTaskbarPreviewAddonPath(location)
  if (!location.fileExists(path)) {
    return {
      status: 'unavailable',
      reason: 'not-built',
      // Named rather than described: a packaged build missing this file is a packaging defect, and
      // the path is what tells the two cases apart in a log.
      detail: path
    }
  }

  let loaded: unknown
  try {
    loaded = loadModule(path)
  } catch (error) {
    return {
      status: 'unavailable',
      reason: 'load-failed',
      detail: error instanceof Error ? error.message : String(error)
    }
  }

  if (!hasExpectedSurface(loaded)) {
    // A stale addon beside a newer app is the shape this catches: it loads, and then a call that
    // does not exist would throw somewhere far from here.
    return { status: 'unavailable', reason: 'incompatible', detail: path }
  }

  return { status: 'available', addon: loaded, path }
}
