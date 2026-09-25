import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () =>
  (await import('./createMainWindow-test-harness')).electronModuleMock()
)
vi.mock('@electron-toolkit/utils', async () =>
  (await import('./createMainWindow-test-harness')).electronToolkitUtilsMock()
)
vi.mock('./macos-tahoe-release', async () =>
  (await import('./createMainWindow-test-harness')).macosTahoeReleaseMock()
)
vi.mock('../app-icon', async () => (await import('./createMainWindow-test-harness')).appIconMock())
vi.mock('../browser/browser-manager', async () =>
  (await import('./createMainWindow-test-harness')).browserManagerMock()
)

import { createMainWindow } from './createMainWindow'
import { RENDERER_REPLACEMENT_EXIT_TIMEOUT_MS, replaceWindowRenderer } from './renderer-replacement'
import { browserWindowMock, resetMainWindowMocks } from './createMainWindow-test-harness'

// Measured on Electron 43.1.0: a forced renderer exits as `crashed` 133, ~80 ms after the call.
const replacedExit = { reason: 'crashed', exitCode: 133 } as Electron.RenderProcessGoneDetails

function createReplaceableWindow(id: number) {
  const windowHandlers: Record<string, (...args: any[]) => void> = {}
  const order: string[] = []
  const webContents = {
    id,
    on: vi.fn((event, handler) => {
      windowHandlers[event] = handler
    }),
    setZoomLevel: vi.fn(),
    setBackgroundThrottling: vi.fn(),
    invalidate: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    send: vi.fn(),
    forcefullyCrashRenderer: vi.fn(() => {
      order.push('crash')
    })
  }
  let destroyed = false
  const browserWindowInstance = {
    webContents,
    on: vi.fn((event, handler) => {
      windowHandlers[event] = handler
    }),
    isDestroyed: vi.fn(() => destroyed),
    isMaximized: vi.fn(() => true),
    isFullScreen: vi.fn(() => false),
    getSize: vi.fn(() => [1200, 800]),
    setSize: vi.fn(),
    maximize: vi.fn(),
    show: vi.fn(),
    loadFile: vi.fn(() => {
      order.push('load')
    }),
    loadURL: vi.fn(() => {
      order.push('load')
    })
  }
  browserWindowMock.mockImplementation(function () {
    return browserWindowInstance
  })
  const emitGone = (): void => windowHandlers['render-process-gone']?.({} as never, replacedExit)
  return {
    webContents,
    browserWindowInstance,
    windowHandlers,
    order,
    emitGone,
    destroy: () => {
      destroyed = true
    }
  }
}

describe('createMainWindow renderer replacement', () => {
  beforeEach(() => {
    resetMainWindowMocks()
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('crashes the renderer, waits for it to exit, then loads the app into a new one', async () => {
    const win = createReplaceableWindow(501)
    const onBeforeRendererReplacement = vi.fn(() => win.order.push('mark'))
    createMainWindow(null, { onBeforeRendererReplacement })
    win.order.length = 0

    const result = replaceWindowRenderer(501)
    await vi.advanceTimersByTimeAsync(0)
    // Reloading before the exit is what leaves a husk on Electron 43.
    expect(win.order).toEqual(['mark', 'crash'])
    expect(onBeforeRendererReplacement).toHaveBeenCalledWith(501)

    win.emitGone()
    await expect(result).resolves.toBe('replaced')
    expect(win.order).toEqual(['mark', 'crash', 'load'])
  })

  it('does not let crash recovery reload a second time or treat the replacement as a crash', async () => {
    const win = createReplaceableWindow(502)
    const shouldRecoverRenderer = vi.fn(() => true)
    const onRendererRecoveryExhausted = vi.fn()
    createMainWindow(null, { shouldRecoverRenderer, onRendererRecoveryExhausted })
    const initialLoads = win.browserWindowInstance.loadFile.mock.calls.length

    const result = replaceWindowRenderer(502)
    await vi.advanceTimersByTimeAsync(0)
    win.emitGone()
    await expect(result).resolves.toBe('replaced')
    await vi.advanceTimersByTimeAsync(1_000)

    expect(win.browserWindowInstance.loadFile.mock.calls.length - initialLoads).toBe(1)
    // The breaker still has all of its recoveries for genuine crashes.
    for (let crash = 0; crash < 3; crash++) {
      win.emitGone()
      await vi.advanceTimersByTimeAsync(250)
    }
    expect(onRendererRecoveryExhausted).not.toHaveBeenCalled()
    expect(win.browserWindowInstance.loadFile.mock.calls.length - initialLoads).toBe(4)
  })

  it('loads nothing when the old renderer never exits, and gives recovery back', async () => {
    const win = createReplaceableWindow(503)
    const onRendererReplacementAbandoned = vi.fn()
    createMainWindow(null, { onRendererReplacementAbandoned })
    const initialLoads = win.browserWindowInstance.loadFile.mock.calls.length

    const result = replaceWindowRenderer(503)
    await vi.advanceTimersByTimeAsync(RENDERER_REPLACEMENT_EXIT_TIMEOUT_MS)

    await expect(result).resolves.toBe('not-terminated')
    expect(win.browserWindowInstance.loadFile.mock.calls.length).toBe(initialLoads)
    expect(onRendererReplacementAbandoned).toHaveBeenCalledWith(503)
    // A late exit is an ordinary crash now, and ordinary recovery brings the window back.
    win.emitGone()
    await vi.advanceTimersByTimeAsync(250)
    expect(win.browserWindowInstance.loadFile.mock.calls.length).toBe(initialLoads + 1)
  })

  it('loads nothing into a window that closed while its renderer was being replaced', async () => {
    const win = createReplaceableWindow(504)
    createMainWindow(null)
    const initialLoads = win.browserWindowInstance.loadFile.mock.calls.length

    const result = replaceWindowRenderer(504)
    await vi.advanceTimersByTimeAsync(0)
    win.destroy()
    win.emitGone()

    await expect(result).resolves.toBe('gone')
    expect(win.browserWindowInstance.loadFile.mock.calls.length).toBe(initialLoads)
  })

  it('stops offering replacement once the window has closed', async () => {
    const win = createReplaceableWindow(505)
    createMainWindow(null)

    win.windowHandlers.closed?.()

    await expect(replaceWindowRenderer(505)).resolves.toBe('unsupported')
    expect(win.webContents.forcefullyCrashRenderer).not.toHaveBeenCalled()
  })
})
