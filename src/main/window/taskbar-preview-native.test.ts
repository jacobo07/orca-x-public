import { describe, expect, it, vi } from 'vitest'
import {
  loadTaskbarPreviewNative,
  resolveTaskbarPreviewAddonPath,
  TASKBAR_PREVIEW_ADDON_FILENAME,
  type TaskbarPreviewNativeLocation
} from './taskbar-preview-native'

/**
 * The addon is an enhancement, so the interesting cases are all the ways it can be missing.
 *
 * Each one has to stay its own answer. Collapsing them would report a packaged build that shipped
 * without its binary as the same thing as a Linux machine, and only one of those is a defect.
 */

const WORKING_ADDON = {
  messages: { sendIconicThumbnail: 0x323, sendIconicLivePreviewBitmap: 0x326 },
  enableIconicRepresentation: () => 0,
  disableIconicRepresentation: () => 0,
  invalidateIconicBitmaps: () => 0,
  drawIconicText: () => 0
}

function location(overrides: Partial<TaskbarPreviewNativeLocation> = {}) {
  return {
    platform: 'win32' as NodeJS.Platform,
    isPackaged: false,
    resourcesPath: 'C:/app/resources',
    projectRoot: 'C:/repo',
    join: (...segments: string[]) => segments.join('/'),
    fileExists: () => true,
    ...overrides
  }
}

describe('resolveTaskbarPreviewAddonPath', () => {
  it('reads a packaged addon from resources, not from a source tree that will not be there', () => {
    expect(resolveTaskbarPreviewAddonPath(location({ isPackaged: true }))).toBe(
      `C:/app/resources/taskbar-preview/${TASKBAR_PREVIEW_ADDON_FILENAME}`
    )
  })

  it('reads a development addon from its build output', () => {
    expect(resolveTaskbarPreviewAddonPath(location())).toBe(
      `C:/repo/native/orca-taskbar-preview/build/Release/${TASKBAR_PREVIEW_ADDON_FILENAME}`
    )
  })
})

describe('loadTaskbarPreviewNative', () => {
  it('loads an addon that exposes the expected surface', () => {
    const result = loadTaskbarPreviewNative(location(), () => WORKING_ADDON)
    expect(result).toMatchObject({ status: 'available' })
  })

  it('does not call this a defect on a platform that has no such capability', () => {
    const loadModule = vi.fn()
    const result = loadTaskbarPreviewNative(location({ platform: 'darwin' }), loadModule)
    expect(result).toEqual({ status: 'unavailable', reason: 'not-windows' })
    // Nothing is even looked for, so a missing file on macOS cannot be mistaken for a build problem.
    expect(loadModule).not.toHaveBeenCalled()
  })

  it('separates an addon that was never compiled from one the runtime refused', () => {
    const neverBuilt = loadTaskbarPreviewNative(
      location({ fileExists: () => false }),
      () => WORKING_ADDON
    )
    expect(neverBuilt).toMatchObject({ status: 'unavailable', reason: 'not-built' })
    // The path is the diagnostic: the same reason means "no MSVC here" in a checkout and "packaging
    // defect" in an installed app, and only the path says which.
    expect(neverBuilt).toMatchObject({ detail: expect.stringContaining('orca-taskbar-preview') })

    const refused = loadTaskbarPreviewNative(location(), () => {
      throw new Error('%1 is not a valid Win32 application')
    })
    expect(refused).toMatchObject({
      status: 'unavailable',
      reason: 'load-failed',
      detail: '%1 is not a valid Win32 application'
    })
  })

  it('refuses a module that loads but is missing part of the surface', () => {
    // A stale binary beside a newer app: it loads fine, and the call that does not exist would
    // otherwise throw somewhere far from the cause.
    const { drawIconicText: _dropped, ...stale } = WORKING_ADDON
    expect(loadTaskbarPreviewNative(location(), () => stale)).toMatchObject({
      status: 'unavailable',
      reason: 'incompatible'
    })
  })

  it('refuses a module whose message constants are absent rather than trusting defaults', () => {
    expect(
      loadTaskbarPreviewNative(location(), () => ({ ...WORKING_ADDON, messages: {} }))
    ).toMatchObject({ status: 'unavailable', reason: 'incompatible' })
  })

  it('never throws out of the load path, whatever the module does', () => {
    expect(() =>
      loadTaskbarPreviewNative(location(), () => {
        throw new Error('boom')
      })
    ).not.toThrow()
  })
})
