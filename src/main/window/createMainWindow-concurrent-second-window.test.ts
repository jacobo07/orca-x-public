// A second project window has to be constructible while the first is still alive.
//
// Electron's ipcMain.handle throws on a channel that already has a handler, and the window-chrome
// channels are registered per window. Registering them once and routing by sender is what makes the
// second construction possible at all — and what stops window B's minimize from minimizing A.
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
const closeDashboardPopoutMock = vi.hoisted(() => vi.fn())
vi.mock('./dashboard-popout-window', () => ({
  closeDashboardPopout: closeDashboardPopoutMock
}))

import { ipcMain } from 'electron'
import { createMainWindow } from './createMainWindow'
import { resetExpectedTeardownStateForTest } from '../crash-reporting/expected-teardown-state'
import { resetWindowChromeIpcRouterForTest } from './window-chrome-ipc-router'
import {
  getWorkspaceWindowForWorktree,
  listWorkspaceWindows,
  resetWorkspaceWindowRegistryForTest
} from './workspace-window-registry'
import { browserWindowMock, resetMainWindowMocks } from './createMainWindow-test-harness'

type WindowDouble = {
  instance: Record<string, ReturnType<typeof vi.fn>> & { webContents: { id: number } }
  events: Record<string, (...args: unknown[]) => void>
}

/** A BrowserWindow stand-in with a distinct webContents id, so sender routing is observable. */
function makeWindowDouble(webContentsId: number): WindowDouble {
  const events: Record<string, (...args: unknown[]) => void> = {}
  const webContents = {
    id: webContentsId,
    on: vi.fn(),
    once: vi.fn(),
    setZoomLevel: vi.fn(),
    setBackgroundThrottling: vi.fn(),
    invalidate: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    send: vi.fn(),
    isDevToolsOpened: vi.fn(() => false),
    openDevTools: vi.fn(),
    closeDevTools: vi.fn(),
    isCrashed: vi.fn(() => false)
  }
  const instance = {
    webContents,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      events[event] = handler
    }),
    once: vi.fn(),
    isDestroyed: vi.fn(() => false),
    isMaximized: vi.fn(() => false),
    isFullScreen: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    isMinimized: vi.fn(() => false),
    getSize: vi.fn(() => [1200, 800]),
    getBounds: vi.fn(() => ({ x: 0, y: 0, width: 1200, height: 800 })),
    setSize: vi.fn(),
    minimize: vi.fn(),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    hide: vi.fn(),
    show: vi.fn(),
    close: vi.fn(),
    destroy: vi.fn(),
    loadFile: vi.fn(),
    loadURL: vi.fn(),
    setMenuBarVisibility: vi.fn(),
    setAutoHideMenuBar: vi.fn()
  } as unknown as WindowDouble['instance']
  return { instance, events }
}

/**
 * Electron throws on a duplicate ipcMain.handle. The shared harness mock records calls without
 * enforcing that, so the contract is enforced here — otherwise the reproduction passes against a
 * mock that is more permissive than the runtime it stands for.
 */
function enforceElectronHandleContract(): void {
  const handled = new Set<string>()
  const invokeHandlers = new Map<string, (...args: unknown[]) => unknown>()
  vi.mocked(ipcMain.handle).mockImplementation(((
    channel: string,
    handler: (...args: unknown[]) => unknown
  ) => {
    if (handled.has(channel)) {
      throw new Error(`Attempted to register a second handler for '${channel}'`)
    }
    handled.add(channel)
    invokeHandlers.set(channel, handler)
  }) as never)
  vi.mocked(ipcMain.removeHandler).mockImplementation(((channel: string) => {
    handled.delete(channel)
    invokeHandlers.delete(channel)
  }) as never)
}

/** Replay an ipcMain.on channel the way Electron would, to whichever listeners are registered. */
function emit(channel: string, event: unknown, ...args: unknown[]): void {
  for (const call of vi.mocked(ipcMain.on).mock.calls) {
    if (call[0] === channel) {
      ;(call[1] as (...callArgs: unknown[]) => void)(event, ...args)
    }
  }
}

describe('createMainWindow with a second window alive', () => {
  beforeEach(() => {
    resetMainWindowMocks()
    resetExpectedTeardownStateForTest()
    resetWindowChromeIpcRouterForTest()
    resetWorkspaceWindowRegistryForTest()
    enforceElectronHandleContract()
  })

  it('constructs a second window while the first is still open', () => {
    const first = makeWindowDouble(11)
    const second = makeWindowDouble(22)
    browserWindowMock
      .mockImplementationOnce(function () {
        return first.instance
      })
      .mockImplementationOnce(function () {
        return second.instance
      })

    createMainWindow(null, { deferLoad: true })

    // The first window is deliberately NOT closed: concurrency is the property under test.
    expect(() => createMainWindow(null, { deferLoad: true })).not.toThrow()
  })

  it('keeps the dashboard pop-out open while another workspace window survives', () => {
    const first = makeWindowDouble(11)
    const second = makeWindowDouble(22)
    browserWindowMock
      .mockImplementationOnce(function () {
        return first.instance
      })
      .mockImplementationOnce(function () {
        return second.instance
      })
    createMainWindow(null, { deferLoad: true })
    createMainWindow(null, { deferLoad: true })
    closeDashboardPopoutMock.mockClear()

    first.events.closed?.()

    // The pop-out is a companion of the application, not of whichever window closed. Closing it
    // here took a surface away from a window that never asked for it to go.
    expect(closeDashboardPopoutMock).not.toHaveBeenCalled()

    second.events.closed?.()

    expect(closeDashboardPopoutMock).toHaveBeenCalledTimes(1)
  })

  it('minimizes only the window whose renderer asked', () => {
    const first = makeWindowDouble(11)
    const second = makeWindowDouble(22)
    browserWindowMock
      .mockImplementationOnce(function () {
        return first.instance
      })
      .mockImplementationOnce(function () {
        return second.instance
      })

    createMainWindow(null, { deferLoad: true })
    createMainWindow(null, { deferLoad: true })

    emit('window:minimize', { sender: { id: 22 } })

    expect(second.instance.minimize).toHaveBeenCalledTimes(1)
    expect(first.instance.minimize).not.toHaveBeenCalled()
  })

  it('closes only the window whose renderer confirmed the close', () => {
    const first = makeWindowDouble(11)
    const second = makeWindowDouble(22)
    browserWindowMock
      .mockImplementationOnce(function () {
        return first.instance
      })
      .mockImplementationOnce(function () {
        return second.instance
      })

    createMainWindow(null, { deferLoad: true })
    createMainWindow(null, { deferLoad: true })

    emit('window:confirm-close', { sender: { id: 11 } })

    expect(first.instance.close).toHaveBeenCalledTimes(1)
    expect(second.instance.close).not.toHaveBeenCalled()
  })

  it('keeps the surviving window bound to its chrome channels after the other closes', () => {
    const first = makeWindowDouble(11)
    const second = makeWindowDouble(22)
    browserWindowMock
      .mockImplementationOnce(function () {
        return first.instance
      })
      .mockImplementationOnce(function () {
        return second.instance
      })

    createMainWindow(null, { deferLoad: true })
    createMainWindow(null, { deferLoad: true })

    // Why this case: the pre-router teardown removed the channels outright, so the first window to
    // close silently unbound the survivor's title-bar controls.
    first.events.closed?.()
    emit('window:minimize', { sender: { id: 22 } })

    expect(second.instance.minimize).toHaveBeenCalledTimes(1)
  })

  it('lets only the first window persist geometry, so the second cannot trample it', () => {
    const first = makeWindowDouble(11)
    const second = makeWindowDouble(22)
    browserWindowMock
      .mockImplementationOnce(function () {
        return first.instance
      })
      .mockImplementationOnce(function () {
        return second.instance
      })
    const updateUI = vi.fn()
    const store = {
      getUI: () => ({ windowBounds: null, windowMaximized: false }),
      getSettings: () => ({}),
      updateUI
    }

    createMainWindow(store as never, { deferLoad: true })
    createMainWindow(store as never, { deferLoad: true })

    // windowBounds/windowMaximized are single keys, so a second live window writing them would
    // overwrite the first window's remembered size on every drag.
    second.events.maximize?.()

    expect(updateUI).not.toHaveBeenCalled()

    first.events.maximize?.()

    expect(updateUI).toHaveBeenCalledWith({ windowMaximized: true })
  })

  it('reopens a saved window under its own identity, project and geometry', () => {
    const restored = makeWindowDouble(11)
    browserWindowMock.mockImplementationOnce(function () {
      return restored.instance
    })
    const onTopologyChanged = vi.fn()

    createMainWindow(null, {
      deferLoad: true,
      onTopologyChanged,
      restore: {
        windowId: 'window-4',
        sequence: 4,
        binding: { repoId: 'repo-1', worktreeId: 'repo-1::/repos/one/feature' },
        bounds: { x: 240, y: 160, width: 1100, height: 760 },
        maximized: false
      }
    })

    expect(getWorkspaceWindowForWorktree('repo-1::/repos/one/feature')?.windowId).toBe('window-4')
    // The recorded rect, not a cascade offset: cascading a restored window would walk the whole
    // saved set a little further across the screen on every relaunch.
    expect(browserWindowMock.mock.calls[0][0]).toMatchObject({
      x: 240,
      y: 160,
      width: 1100,
      height: 760
    })
    expect(onTopologyChanged).toHaveBeenCalled()
  })

  it('re-records the topology when a window closes, so a deliberate close is forgotten', () => {
    const first = makeWindowDouble(11)
    const second = makeWindowDouble(22)
    browserWindowMock
      .mockImplementationOnce(function () {
        return first.instance
      })
      .mockImplementationOnce(function () {
        return second.instance
      })
    const onTopologyChanged = vi.fn()

    createMainWindow(null, { deferLoad: true, onTopologyChanged })
    createMainWindow(null, { deferLoad: true, onTopologyChanged })
    onTopologyChanged.mockClear()

    second.events.closed?.()

    // Fires after the registry drops the window, so the capture the host takes here is the survivors.
    expect(onTopologyChanged).toHaveBeenCalledTimes(1)
    expect(listWorkspaceWindows()).toHaveLength(1)
  })
})
