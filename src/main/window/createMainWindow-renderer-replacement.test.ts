import { beforeEach, describe, expect, it, vi } from 'vitest'

const { showMessageBox } = vi.hoisted(() => ({ showMessageBox: vi.fn() }))

vi.mock('electron', async () => {
  const electron = (await import('./createMainWindow-test-harness')).electronModuleMock()
  return {
    ...electron,
    BrowserWindow: Object.assign(electron.BrowserWindow, { fromWebContents: () => null }),
    dialog: { showMessageBox }
  }
})
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
vi.mock('../i18n/main-i18n', () => ({
  translateMain: (_key: string, fallback: string) => fallback
}))

import { createMainWindow } from './createMainWindow'
import { RENDERER_REPLACEMENT_EXIT_TIMEOUT_MS, replaceWindowRenderer } from './renderer-replacement'
import { resetReloadPreparationForTest } from './reload-preparation'
import {
  FORCE_RELOAD_PREPARE_TIMEOUT_MS,
  resetWindowReloadTransactionsForTest
} from './window-reload-transaction'
import { browserWindowMock, resetMainWindowMocks } from './createMainWindow-test-harness'

// Measured on Electron 43.1.0: a forced renderer exits as `crashed` 133, ~80 ms after the call.
const replacedExit = { reason: 'crashed', exitCode: 133 } as Electron.RenderProcessGoneDetails

function createReplaceableWindow(id: number) {
  const windowHandlers: Record<string, (...args: any[]) => void> = {}
  const order: string[] = []
  let destroyed = false
  const webContents = {
    id,
    on: vi.fn((event, handler) => {
      windowHandlers[event] = handler
    }),
    once: vi.fn(),
    removeListener: vi.fn(),
    isDestroyed: () => destroyed,
    getOSProcessId: () => 7000 + id,
    setZoomLevel: vi.fn(),
    setBackgroundThrottling: vi.fn(),
    invalidate: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    // A hung renderer: it never answers the reload-preparation request this sends.
    send: vi.fn(),
    reload: vi.fn(() => {
      order.push('reload')
    }),
    reloadIgnoringCache: vi.fn(() => {
      order.push('reloadIgnoringCache')
    }),
    forcefullyCrashRenderer: vi.fn(() => {
      order.push('crash')
    })
  }
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
  const pressForceReload = (): void => {
    const isDarwin = process.platform === 'darwin'
    windowHandlers['before-input-event']?.(
      { preventDefault: vi.fn() } as never,
      {
        type: 'keyDown',
        code: 'KeyR',
        key: 'R',
        meta: isDarwin,
        control: !isDarwin,
        alt: false,
        shift: true
      } as never
    )
  }
  return {
    webContents,
    browserWindowInstance,
    windowHandlers,
    order,
    emitGone,
    pressForceReload,
    destroy: () => {
      destroyed = true
    }
  }
}

describe('createMainWindow renderer replacement', () => {
  beforeEach(() => {
    resetMainWindowMocks()
    resetReloadPreparationForTest()
    resetWindowReloadTransactionsForTest()
    showMessageBox.mockReset()
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

  it('Ctrl+Shift+R on a renderer that does not answer asks, then replaces it after it exits', async () => {
    const win = createReplaceableWindow(506)
    const onBeforeReload = vi.fn()
    showMessageBox.mockResolvedValue({ response: 1 })
    createMainWindow(null, { onBeforeReload })
    win.order.length = 0

    win.pressForceReload()
    await vi.advanceTimersByTimeAsync(FORCE_RELOAD_PREPARE_TIMEOUT_MS)

    expect(win.webContents.send).toHaveBeenCalledWith(
      'app:prepareForReload',
      expect.objectContaining({ requestId: expect.any(String) })
    )
    expect(showMessageBox).toHaveBeenCalledTimes(1)
    expect(win.order).toEqual(['crash'])

    win.emitGone()
    await vi.advanceTimersByTimeAsync(0)
    expect(win.order).toEqual(['crash', 'load'])
    // No same-process reload of a hung renderer, and no mark for one.
    expect(win.webContents.reloadIgnoringCache).not.toHaveBeenCalled()
    expect(onBeforeReload).not.toHaveBeenCalled()
  })

  it('Ctrl+Shift+R cancelled at the confirm leaves the hung window untouched', async () => {
    const win = createReplaceableWindow(507)
    showMessageBox.mockResolvedValue({ response: 0 })
    createMainWindow(null)
    win.order.length = 0

    win.pressForceReload()
    await vi.advanceTimersByTimeAsync(FORCE_RELOAD_PREPARE_TIMEOUT_MS + RENDERER_REPLACEMENT_EXIT_TIMEOUT_MS)

    expect(showMessageBox).toHaveBeenCalledTimes(1)
    expect(win.order).toEqual([])
  })
})
