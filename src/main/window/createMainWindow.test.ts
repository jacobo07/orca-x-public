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

import { createMainWindow, loadMainWindow } from './createMainWindow'
import { ipcMain } from 'electron'
import { resetExpectedTeardownStateForTest } from '../crash-reporting/expected-teardown-state'
import {
  attachGuestPoliciesMock,
  browserWindowMock,
  macosTahoeMock,
  openExternalMock,
  powerMonitorOnMock,
  resetMainWindowMocks,
  withPlatform
} from './createMainWindow-test-harness'

describe('createMainWindow', () => {
  beforeEach(() => {
    resetMainWindowMocks()
    resetExpectedTeardownStateForTest()
    vi.useRealTimers()
  })

  it('can defer renderer loading until startup IPC handlers are registered', () => {
    const webContents = {
      on: vi.fn(),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isDevToolsOpened: vi.fn(),
      openDevTools: vi.fn(),
      closeDevTools: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    const win = createMainWindow(null, { deferLoad: true })

    expect(browserWindowInstance.loadFile).not.toHaveBeenCalled()
    expect(browserWindowInstance.loadURL).not.toHaveBeenCalled()

    loadMainWindow(win)

    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(1)
    expect(browserWindowInstance.loadURL).not.toHaveBeenCalled()
  })

  it('enables renderer sandboxing and opens external links safely', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      once: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn((handler) => {
        windowHandlers.windowOpen = handler
      }),
      send: vi.fn(),
      isDevToolsOpened: vi.fn(),
      openDevTools: vi.fn(),
      closeDevTools: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    createMainWindow(null)

    expect(browserWindowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        webPreferences: expect.objectContaining({ sandbox: true })
      })
    )
    const browserWindowOptions = browserWindowMock.mock.calls[0]?.[0]
    // Why: macOS swallows the app-activating click unless the window accepts
    // first mouse, forcing a second click to focus the floating workspace.
    expect(browserWindowOptions.acceptFirstMouse).toBe(true)
    if (process.platform === 'darwin') {
      expect(browserWindowOptions).toMatchObject({
        titleBarStyle: 'hiddenInset'
      })
    } else if (process.platform === 'win32') {
      expect(browserWindowOptions).toMatchObject({
        titleBarStyle: 'hidden'
      })
    } else {
      // Linux: native frame is dropped so the renderer titlebar isn't stacked
      // under the WM title bar (double title bar). titleBarStyle stays unset.
      expect(browserWindowOptions.titleBarStyle).toBeUndefined()
      expect(browserWindowOptions.frame).toBe(false)
    }

    expect(windowHandlers.windowOpen({ url: 'https://example.com' })).toEqual({ action: 'deny' })
    expect(windowHandlers.windowOpen({ url: 'localhost:3000' })).toEqual({ action: 'deny' })
    expect(windowHandlers.windowOpen({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' })
    expect(windowHandlers.windowOpen({ url: 'not a url' })).toEqual({ action: 'deny' })

    expect(openExternalMock).toHaveBeenCalledTimes(2)
    expect(openExternalMock).toHaveBeenCalledWith('https://example.com/')
    expect(openExternalMock).toHaveBeenCalledWith('http://localhost:3000/')

    const preventDefault = vi.fn()
    windowHandlers['will-navigate']({ preventDefault } as never, 'https://example.com/docs')
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(openExternalMock).toHaveBeenCalledTimes(3)
    expect(openExternalMock).toHaveBeenLastCalledWith('https://example.com/docs')

    const localhostPreventDefault = vi.fn()
    windowHandlers['will-navigate'](
      { preventDefault: localhostPreventDefault } as never,
      'localhost:3000'
    )
    expect(localhostPreventDefault).toHaveBeenCalledTimes(1)
    expect(openExternalMock).toHaveBeenCalledTimes(4)
    expect(openExternalMock).toHaveBeenLastCalledWith('http://localhost:3000/')

    const fileNavigationPreventDefault = vi.fn()
    windowHandlers['will-navigate'](
      { preventDefault: fileNavigationPreventDefault } as never,
      'file:///etc/passwd'
    )
    expect(fileNavigationPreventDefault).toHaveBeenCalledTimes(1)
    expect(openExternalMock).toHaveBeenCalledTimes(4)

    const allowBlankEvent = { preventDefault: vi.fn() }
    const allowBlankPrefs = { partition: 'persist:orca-browser' }
    windowHandlers['will-attach-webview'](
      allowBlankEvent as never,
      allowBlankPrefs as never,
      { src: 'data:text/html,' } as never
    )
    expect(allowBlankEvent.preventDefault).not.toHaveBeenCalled()
    expect(allowBlankPrefs).toMatchObject({
      disableHtmlFullscreenWindowResize: true,
      partition: 'persist:orca-browser',
      preload: expect.stringMatching(/browser-window-close-preload\.js$/),
      sandbox: true
    })

    const denyInlineHtmlEvent = { preventDefault: vi.fn() }
    windowHandlers['will-attach-webview'](
      denyInlineHtmlEvent as never,
      { partition: 'persist:orca-browser' } as never,
      { src: 'data:text/html,<script>alert(1)</script>' } as never
    )
    expect(denyInlineHtmlEvent.preventDefault).toHaveBeenCalledTimes(1)

    const guest = { marker: 'guest' }
    windowHandlers['did-attach-webview']({} as never, guest as never)
    expect(attachGuestPoliciesMock).toHaveBeenCalledWith(guest)

    const untrustedPreloadParams = {
      src: 'data:text/html,',
      preload: 'file:///tmp/untrusted-preload.js'
    }
    const hardenedPrefs = {
      partition: 'persist:orca-browser',
      preload: '/tmp/untrusted-preload.js'
    }
    windowHandlers['will-attach-webview'](
      { preventDefault: vi.fn() } as never,
      hardenedPrefs as never,
      untrustedPreloadParams as never
    )
    expect(untrustedPreloadParams.preload).toBeUndefined()
    expect(hardenedPrefs.preload).toMatch(/browser-window-close-preload\.js$/)
    expect(hardenedPrefs.preload).not.toContain('untrusted-preload')

    const secondGuest = { marker: 'second-guest' }
    windowHandlers['did-attach-webview']({} as never, secondGuest as never)
    expect(attachGuestPoliciesMock).toHaveBeenLastCalledWith(secondGuest)
  })

  it('sets platform-specific titlebar and frame options for every desktop platform', () => {
    for (const [platform, expected] of [
      ['darwin', { titleBarStyle: 'hiddenInset', frame: undefined }],
      ['win32', { titleBarStyle: 'hidden', frame: undefined }],
      ['linux', { titleBarStyle: undefined, frame: false }]
    ] satisfies [
      NodeJS.Platform,
      { titleBarStyle: string | undefined; frame: boolean | undefined }
    ][]) {
      browserWindowMock.mockReset()
      const webContents = {
        on: vi.fn(),
        setZoomLevel: vi.fn(),
        setBackgroundThrottling: vi.fn(),
        invalidate: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        send: vi.fn(),
        isDevToolsOpened: vi.fn(),
        openDevTools: vi.fn(),
        closeDevTools: vi.fn()
      }
      const browserWindowInstance = {
        webContents,
        on: vi.fn(),
        isDestroyed: vi.fn(() => false),
        isMaximized: vi.fn(() => true),
        isFullScreen: vi.fn(() => false),
        getSize: vi.fn(() => [1200, 800]),
        setSize: vi.fn(),
        setWindowButtonPosition: vi.fn(),
        maximize: vi.fn(),
        show: vi.fn(),
        loadFile: vi.fn(),
        loadURL: vi.fn()
      }
      browserWindowMock.mockImplementation(function () {
        return browserWindowInstance
      })

      withPlatform(platform, () => createMainWindow(null))

      const browserWindowOptions = browserWindowMock.mock.calls[0]?.[0]
      expect(browserWindowOptions.titleBarStyle).toBe(expected.titleBarStyle)
      expect(browserWindowOptions.frame).toBe(expected.frame)
    }
  })

  it('never requests macOS vibrancy or transparency when window blur is enabled (#8482)', () => {
    for (const [platform, expected] of [
      ['darwin', { backgroundMaterial: undefined }],
      ['win32', { backgroundMaterial: 'acrylic' }],
      ['linux', { backgroundMaterial: undefined }]
    ] satisfies [NodeJS.Platform, { backgroundMaterial: string | undefined }][]) {
      browserWindowMock.mockReset()
      const webContents = {
        on: vi.fn(),
        setZoomLevel: vi.fn(),
        setBackgroundThrottling: vi.fn(),
        invalidate: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        send: vi.fn(),
        isDevToolsOpened: vi.fn(),
        openDevTools: vi.fn(),
        closeDevTools: vi.fn()
      }
      const browserWindowInstance = {
        webContents,
        on: vi.fn(),
        isDestroyed: vi.fn(() => false),
        isMaximized: vi.fn(() => false),
        isFullScreen: vi.fn(() => false),
        getSize: vi.fn(() => [1200, 800]),
        getBounds: vi.fn(() => ({ x: 10, y: 20, width: 1000, height: 700 })),
        setSize: vi.fn(),
        setWindowButtonPosition: vi.fn(),
        maximize: vi.fn(),
        show: vi.fn(),
        loadFile: vi.fn(),
        loadURL: vi.fn()
      }
      browserWindowMock.mockImplementation(function () {
        return browserWindowInstance
      })

      withPlatform(platform, () =>
        createMainWindow({
          getUI: () => ({}),
          getSettings: () => ({ windowBackgroundBlur: true }),
          updateUI: vi.fn()
        } as never)
      )

      const browserWindowOptions = browserWindowMock.mock.calls[0]?.[0]
      expect(browserWindowOptions.vibrancy).toBeUndefined()
      expect(browserWindowOptions.transparent).toBeUndefined()
      expect(browserWindowOptions.backgroundMaterial).toBe(expected.backgroundMaterial)
      expect(browserWindowOptions.backgroundColor).toBe('#ffffff')
    }
  })

  it('keeps macOS background throttling enabled while repainting visibility transitions', () => {
    vi.useFakeTimers()
    const windowHandlers = new Map<string, ((...args: any[]) => void)[]>()
    let windowSize: [number, number] = [1200, 800]
    const webContents = {
      on: vi.fn(),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      isDestroyed: vi.fn(() => false),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isDevToolsOpened: vi.fn(),
      openDevTools: vi.fn(),
      closeDevTools: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        const handlers = windowHandlers.get(event) ?? []
        handlers.push(handler)
        windowHandlers.set(event, handlers)
      }),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => false),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => windowSize),
      setSize: vi.fn((width: number, height: number) => {
        windowSize = [width, height]
      }),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    withPlatform('darwin', () => createMainWindow(null))

    expect(webContents.setBackgroundThrottling).toHaveBeenCalledWith(true)
    expect(webContents.setBackgroundThrottling).not.toHaveBeenCalledWith(false)
    expect(windowHandlers.get('restore')).toHaveLength(1)
    expect(windowHandlers.get('show')).toHaveLength(1)
    expect(windowHandlers.get('focus')).toHaveLength(1)

    windowHandlers.get('show')?.[0]?.()
    windowHandlers.get('restore')?.[0]?.()

    expect(webContents.invalidate).toHaveBeenCalledTimes(2)
    // Why: the size nudge must never run inside the show/restore dispatch itself.
    expect(browserWindowInstance.setSize).not.toHaveBeenCalled()

    vi.advanceTimersByTime(0)
    expect(browserWindowInstance.setSize).toHaveBeenNthCalledWith(1, 1201, 800)
    expect(browserWindowInstance.setSize).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(32)
    expect(browserWindowInstance.setSize).toHaveBeenNthCalledWith(2, 1200, 800)

    vi.advanceTimersByTime(217)
    expect(webContents.invalidate).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(1)
    expect(webContents.invalidate).toHaveBeenCalledTimes(3)

    // Why: focus covers occlusion-uncover with invalidate only — no setSize
    // jiggle that would resize terminals on every window focus.
    const setSizeCalls = browserWindowInstance.setSize.mock.calls.length
    windowHandlers.get('focus')?.[0]?.()
    expect(webContents.invalidate).toHaveBeenCalledTimes(4)
    expect(browserWindowInstance.setSize).toHaveBeenCalledTimes(setSizeCalls)
  })

  function mountWindowForPlatform(platform: NodeJS.Platform): {
    webContents: Record<string, ReturnType<typeof vi.fn>>
    windowHandlers: Map<string, ((...args: any[]) => void)[]>
  } {
    const windowHandlers = new Map<string, ((...args: any[]) => void)[]>()
    let windowSize: [number, number] = [1200, 800]
    const webContents = {
      on: vi.fn(),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      isDestroyed: vi.fn(() => false),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isDevToolsOpened: vi.fn(),
      openDevTools: vi.fn(),
      closeDevTools: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        const handlers = windowHandlers.get(event) ?? []
        handlers.push(handler)
        windowHandlers.set(event, handlers)
      }),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => false),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => windowSize),
      setSize: vi.fn((width: number, height: number) => {
        windowSize = [width, height]
      }),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })
    withPlatform(platform, () => createMainWindow(null))
    return { webContents, windowHandlers }
  }

  it('installs the reveal repaint on exactly the platforms that throttle a hidden window', () => {
    // Why an equality rather than a per-platform expectation: the reveal repaint is not a general
    // "restore needs an invalidate" contract, it is compensation for this app's own decision to
    // background-throttle the hidden window. A throttled, occluded window comes back with layers
    // and a stale dynamic-viewport height that only a repaint plus reflow corrects (STA-2383, the
    // clipped status bar). A platform that never throttles never enters that state, so it needs no
    // backstop — and giving it one would cost a size nudge that SIGWINCHes every terminal, which is
    // exactly why the occlusion path avoids it.
    //
    // Pinning the coupling makes both directions fail: enabling throttling on a new platform
    // without the backstop, or dropping the backstop while throttling stays on.
    const observed = new Map<string, { throttlesHiddenWindow: boolean; installsBackstop: boolean }>()
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      resetMainWindowMocks()
      const { webContents, windowHandlers } = mountWindowForPlatform(platform)
      observed.set(platform, {
        throttlesHiddenWindow: webContents.setBackgroundThrottling.mock.calls.some(
          ([allowed]) => allowed === true
        ),
        installsBackstop: (windowHandlers.get('restore')?.length ?? 0) > 0
      })
    }

    for (const [platform, { throttlesHiddenWindow, installsBackstop }] of observed) {
      expect(
        installsBackstop,
        `${platform} throttles=${throttlesHiddenWindow} but installs the reveal repaint=${installsBackstop}; a platform needs that backstop when, and only when, it throttles its hidden window`
      ).toBe(throttlesHiddenWindow)
    }

    // The control. Without both answers present the equality above holds for a sweep in which
    // nothing throttles and nothing installs anything, which would assert nothing at all.
    const answers = [...observed.values()]
    expect(
      answers.some((entry) => entry.throttlesHiddenWindow),
      'no platform in the sweep throttled its hidden window, so the coupling was never exercised'
    ).toBe(true)
    expect(
      answers.some((entry) => !entry.throttlesHiddenWindow),
      'every platform in the sweep throttled, so the "no throttling, no backstop" half was never exercised'
    ).toBe(true)
  })

  it('still repaints a Windows window on system resume, where it installs no reveal backstop', () => {
    // The other half of the same story: Windows is not left without compositor recovery. It has no
    // show/restore/focus backstop because it has no throttled-hidden state to recover from, but the
    // resume relay is cross-platform — a focus-preserving display wake fires neither focus nor
    // visibilitychange, so main invalidates and tells the renderer to run its own wake recovery.
    const { webContents, windowHandlers } = mountWindowForPlatform('win32')

    expect(windowHandlers.get('restore') ?? []).toHaveLength(0)
    const onResume = powerMonitorOnMock.mock.calls.find(([event]) => event === 'resume')?.[1] as
      | (() => void)
      | undefined
    expect(onResume, 'no system-resume handler was registered on Windows').toBeTypeOf('function')

    onResume?.()

    expect(webContents.invalidate).toHaveBeenCalledTimes(1)
    expect(webContents.send).toHaveBeenCalledWith('system:resumed')
  })

  it('runs a full repaint when the renderer relays a genuine window reveal (STA-2383)', () => {
    vi.useFakeTimers()
    const windowHandlers = new Map<string, ((...args: any[]) => void)[]>()
    let windowSize: [number, number] = [1200, 800]
    const webContents = {
      on: vi.fn(),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      isDestroyed: vi.fn(() => false),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isDevToolsOpened: vi.fn(),
      openDevTools: vi.fn(),
      closeDevTools: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        const handlers = windowHandlers.get(event) ?? []
        handlers.push(handler)
        windowHandlers.set(event, handlers)
      }),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => false),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => windowSize),
      setSize: vi.fn((width: number, height: number) => {
        windowSize = [width, height]
      }),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    withPlatform('darwin', () => createMainWindow(null))

    const revealHandler = vi
      .mocked(ipcMain.on)
      .mock.calls.find(([channel]) => channel === 'ui:window-revealed')?.[1]
    expect(revealHandler).toBeTypeOf('function')

    // Why: a reveal relayed by another window's webContents must not repaint this one.
    revealHandler?.({ sender: {} } as never)
    expect(browserWindowInstance.setSize).not.toHaveBeenCalled()
    expect(webContents.invalidate).not.toHaveBeenCalled()

    // The genuine reveal runs the pre-Tahoe compositor jiggle that bare focus avoids.
    revealHandler?.({ sender: webContents } as never)
    expect(webContents.invalidate).toHaveBeenCalledTimes(1)
    // Why: the nudge is deferred off the event dispatch turn.
    expect(browserWindowInstance.setSize).not.toHaveBeenCalled()
    vi.advanceTimersByTime(0)
    expect(browserWindowInstance.setSize).toHaveBeenNthCalledWith(1, 1201, 800)
    vi.advanceTimersByTime(32)
    expect(browserWindowInstance.setSize).toHaveBeenNthCalledWith(2, 1200, 800)

    // Repeated reveal signals while a jiggle is active repaint but do not multiply terminal resizes.
    revealHandler?.({ sender: webContents } as never)
    revealHandler?.({ sender: webContents } as never)
    expect(webContents.invalidate).toHaveBeenCalledTimes(3)
    vi.advanceTimersByTime(0)
    expect(browserWindowInstance.setSize).toHaveBeenNthCalledWith(3, 1201, 800)
    expect(browserWindowInstance.setSize).toHaveBeenCalledTimes(3)

    // A user resize that lands during the jiggle must not be rolled back to stale bounds.
    windowSize = [1400, 900]
    vi.advanceTimersByTime(32)
    expect(browserWindowInstance.setSize).toHaveBeenCalledTimes(3)

    windowHandlers.get('closed')?.[0]?.()
    expect(ipcMain.removeListener).toHaveBeenCalledWith('ui:window-revealed', revealHandler)
  })

  it('repaints without the size nudge on macOS 26+ where re-entrant frame updates can deadlock AppKit', () => {
    vi.useFakeTimers()
    macosTahoeMock.value = true
    const windowHandlers = new Map<string, ((...args: any[]) => void)[]>()
    const webContents = {
      on: vi.fn(),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      isDestroyed: vi.fn(() => false),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isDevToolsOpened: vi.fn(),
      openDevTools: vi.fn(),
      closeDevTools: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        const handlers = windowHandlers.get(event) ?? []
        handlers.push(handler)
        windowHandlers.set(event, handlers)
      }),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => false),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    withPlatform('darwin', () => createMainWindow(null))

    windowHandlers.get('show')?.[0]?.()
    expect(webContents.invalidate).toHaveBeenCalledTimes(1)

    // Why: the delayed second repaint must also stay setSize-free on Tahoe.
    vi.advanceTimersByTime(300)
    expect(webContents.invalidate).toHaveBeenCalledTimes(2)
    expect(browserWindowInstance.setSize).not.toHaveBeenCalled()
  })

  it('invalidates a maximized macOS 26 window without changing its frame', () => {
    vi.useFakeTimers()
    macosTahoeMock.value = true
    const windowHandlers = new Map<string, ((...args: any[]) => void)[]>()
    const webContents = {
      on: vi.fn(),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      isDestroyed: vi.fn(() => false),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isDevToolsOpened: vi.fn(),
      openDevTools: vi.fn(),
      closeDevTools: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        const handlers = windowHandlers.get(event) ?? []
        handlers.push(handler)
        windowHandlers.set(event, handlers)
      }),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => true),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    withPlatform('darwin', () => createMainWindow(null))

    windowHandlers.get('show')?.[0]?.()
    vi.advanceTimersByTime(300)

    expect(webContents.invalidate).toHaveBeenCalledTimes(2)
    expect(browserWindowInstance.setSize).not.toHaveBeenCalled()
  })

  it('invalidates without frame or device emulation when macOS 26 wakes from sleep', () => {
    vi.useFakeTimers()
    macosTahoeMock.value = true
    const windowHandlers = new Map<string, ((...args: any[]) => void)[]>()
    const webContents = {
      on: vi.fn(),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      isDestroyed: vi.fn(() => false),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isDevToolsOpened: vi.fn(),
      openDevTools: vi.fn(),
      closeDevTools: vi.fn(),
      enableDeviceEmulation: vi.fn(),
      disableDeviceEmulation: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        const handlers = windowHandlers.get(event) ?? []
        handlers.push(handler)
        windowHandlers.set(event, handlers)
      }),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => false),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    withPlatform('darwin', () => createMainWindow(null))

    const resumeHandler = powerMonitorOnMock.mock.calls.find(
      ([event]) => event === 'resume'
    )?.[1] as (() => void) | undefined
    expect(resumeHandler).toBeDefined()
    resumeHandler?.()

    expect(webContents.invalidate).toHaveBeenCalled()
    vi.advanceTimersByTime(300)
    expect(browserWindowInstance.setSize).not.toHaveBeenCalled()
    expect(webContents.enableDeviceEmulation).not.toHaveBeenCalled()
    expect(webContents.disableDeviceEmulation).not.toHaveBeenCalled()
  })
})
