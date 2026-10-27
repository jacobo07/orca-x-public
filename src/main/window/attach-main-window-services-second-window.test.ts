import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'

/**
 * A second workspace window must not take capabilities away from the first.
 *
 * `attachMainWindowServices` runs once per window, and every window-coupled registrar removes its
 * channel before registering it — which is what stops `ipcMain.handle` throwing on the duplicate.
 * The cost is that the surviving handler closes over the newest window, so the first window's calls
 * either return nothing (the registrars that compare the caller against a captured WebContents) or
 * are answered into the wrong window (the ones that capture without comparing).
 *
 * Neither failure raises. These tests exist because the only way to see them is to ask the first
 * window to do something after the second one exists.
 */

const {
  onMock,
  removeAllListenersMock,
  removeListenerMock,
  setPermissionRequestHandlerMock,
  setPermissionCheckHandlerMock,
  handleMock,
  removeHandlerMock,
  systemPreferencesAskForMediaAccessMock,
  systemPreferencesGetMediaAccessStatusMock,
  registerRepoHandlersMock,
  setRepoRemoteClientNotifierMock,
  registerWorktreeHandlersMock,
  registerPtyHandlersMock,
  hydrateLocalPtyRegistryAtBootMock,
  setupAutoUpdaterMock,
  browserManagerUnregisterAllMock,
  runWorktreeChangeInvalidatorsMock,
  acknowledgePendingTccPromptNoticeMock,
  consumePendingTccPromptNoticeMock,
  dismissTccPromptNoticeMock,
  releasePendingTccPromptNoticeMock
} = vi.hoisted(() => ({
  onMock: vi.fn(),
  removeAllListenersMock: vi.fn(),
  removeListenerMock: vi.fn(),
  setPermissionRequestHandlerMock: vi.fn(),
  setPermissionCheckHandlerMock: vi.fn(),
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  systemPreferencesAskForMediaAccessMock: vi.fn(),
  systemPreferencesGetMediaAccessStatusMock: vi.fn(),
  registerRepoHandlersMock: vi.fn(),
  setRepoRemoteClientNotifierMock: vi.fn(),
  registerWorktreeHandlersMock: vi.fn(),
  registerPtyHandlersMock: vi.fn(),
  hydrateLocalPtyRegistryAtBootMock: vi.fn(),
  setupAutoUpdaterMock: vi.fn(),
  browserManagerUnregisterAllMock: vi.fn(),
  runWorktreeChangeInvalidatorsMock: vi.fn(),
  acknowledgePendingTccPromptNoticeMock: vi.fn(),
  consumePendingTccPromptNoticeMock: vi.fn(),
  dismissTccPromptNoticeMock: vi.fn(),
  releasePendingTccPromptNoticeMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {},
  clipboard: {},
  systemPreferences: {
    askForMediaAccess: systemPreferencesAskForMediaAccessMock,
    getMediaAccessStatus: systemPreferencesGetMediaAccessStatusMock
  },
  ipcMain: {
    on: onMock,
    removeAllListeners: removeAllListenersMock,
    removeListener: removeListenerMock,
    removeHandler: removeHandlerMock,
    handle: handleMock
  },
  powerMonitor: {
    on: vi.fn(),
    off: vi.fn()
  }
}))

vi.mock('../ipc/repos', () => ({
  registerRepoHandlers: registerRepoHandlersMock,
  setRepoRemoteClientNotifier: setRepoRemoteClientNotifierMock
}))

vi.mock('../ipc/worktrees', () => ({
  registerWorktreeHandlers: registerWorktreeHandlersMock
}))

vi.mock('../ipc/worktree-change-invalidators', () => ({
  runWorktreeChangeInvalidators: runWorktreeChangeInvalidatorsMock
}))

vi.mock('../ipc/pty', () => ({
  getLocalPtyProvider: vi.fn(),
  registerPtyHandlers: registerPtyHandlersMock
}))

vi.mock('../memory/hydrate-local-pty-registry', () => ({
  hydrateLocalPtyRegistryAtBoot: hydrateLocalPtyRegistryAtBootMock
}))

vi.mock('../browser/browser-manager', () => ({
  browserManager: {
    unregisterAll: browserManagerUnregisterAllMock
  }
}))

vi.mock('../updater', () => ({
  checkForUpdates: vi.fn(),
  getUpdateStatus: vi.fn(),
  quitAndInstall: vi.fn(),
  dismissNudge: vi.fn(),
  setupAutoUpdater: setupAutoUpdaterMock
}))

vi.mock('../macos-tcc-prompt-notice', () => ({
  acknowledgePendingTccPromptNotice: acknowledgePendingTccPromptNoticeMock,
  consumePendingTccPromptNotice: consumePendingTccPromptNoticeMock,
  dismissTccPromptNotice: dismissTccPromptNoticeMock,
  releasePendingTccPromptNotice: releasePendingTccPromptNoticeMock
}))

import { attachMainWindowServices } from './attach-main-window-services'
import { resetWindowServiceIpcRouterForTest } from './window-service-ipc-router'

type MockFn = ReturnType<typeof vi.fn>

type WindowStub = {
  id: number
  isDestroyed: MockFn
  on: MockFn
  once: MockFn
  webContents: {
    id: number
    getURL: MockFn
    isDestroyed: MockFn
    isLoadingMainFrame: MockFn
    on: MockFn
    send: MockFn
    reload: MockFn
    session: {
      setPermissionRequestHandler: MockFn
      setPermissionCheckHandler: MockFn
    }
  }
}

function createWindowStub(id: number): WindowStub {
  return {
    id,
    isDestroyed: vi.fn(() => false),
    on: vi.fn(),
    once: vi.fn(),
    webContents: {
      id,
      getURL: vi.fn(() => 'file:///opt/orca/renderer/index.html'),
      isDestroyed: vi.fn(() => false),
      isLoadingMainFrame: vi.fn(() => true),
      on: vi.fn(),
      send: vi.fn(),
      reload: vi.fn(),
      session: {
        setPermissionRequestHandler: setPermissionRequestHandlerMock,
        setPermissionCheckHandler: setPermissionCheckHandlerMock
      }
    }
  }
}

function createStore(): Store {
  return {
    getProfileStorageDirectory: vi.fn(() => '/profile-a'),
    flushPendingAsync: vi.fn(() => Promise.resolve())
  } as unknown as Store
}

function createRuntime(): Record<string, MockFn> {
  return {
    attachWindow: vi.fn(),
    setNotifier: vi.fn(),
    noteWindowFocused: vi.fn(),
    markRendererReloading: vi.fn(),
    markRendererReloadCancelled: vi.fn(),
    markGraphReloadFailed: vi.fn(),
    markGraphUnavailable: vi.fn()
  }
}

/** The handler a renderer would actually reach: the most recent registration for the channel. */
function liveHandler(channel: string): ((...args: never[]) => unknown) | undefined {
  const matching = handleMock.mock.calls.filter(([registered]) => registered === channel)
  return matching.at(-1)?.[1] as ((...args: never[]) => unknown) | undefined
}

function liveListener(channel: string): ((...args: never[]) => unknown) | undefined {
  const matching = onMock.mock.calls.filter(([registered]) => registered === channel)
  return matching.at(-1)?.[1] as ((...args: never[]) => unknown) | undefined
}

function attach(window: WindowStub): void {
  attachMainWindowServices(
    window as never,
    createStore(),
    createRuntime() as never,
    undefined,
    undefined,
    {}
  )
}

describe('attachMainWindowServices with a second window', () => {
  beforeEach(() => {
    for (const mock of [
      onMock,
      removeAllListenersMock,
      removeListenerMock,
      handleMock,
      removeHandlerMock,
      setPermissionRequestHandlerMock,
      setPermissionCheckHandlerMock,
      systemPreferencesAskForMediaAccessMock,
      systemPreferencesGetMediaAccessStatusMock,
      registerRepoHandlersMock,
      setRepoRemoteClientNotifierMock,
      registerWorktreeHandlersMock,
      registerPtyHandlersMock,
      hydrateLocalPtyRegistryAtBootMock,
      setupAutoUpdaterMock,
      browserManagerUnregisterAllMock,
      acknowledgePendingTccPromptNoticeMock,
      consumePendingTccPromptNoticeMock,
      dismissTccPromptNoticeMock,
      releasePendingTccPromptNoticeMock
    ]) {
      mock.mockReset()
    }
    // Why: the router registers its channels once per process, so a suite that resets the ipcMain
    // mock must reset the router too, or later cases observe no registration at all.
    resetWindowServiceIpcRouterForTest()
    systemPreferencesAskForMediaAccessMock.mockResolvedValue(true)
    systemPreferencesGetMediaAccessStatusMock.mockReturnValue('granted')
    consumePendingTccPromptNoticeMock.mockReturnValue({ claimId: 7 })
  })

  it('still reloads the first window after a second window attaches', async () => {
    const first = createWindowStub(1)
    const second = createWindowStub(2)
    attach(first)
    attach(second)

    await liveHandler('app:reload')?.({ sender: first.webContents } as never)

    // Today this reload is dropped: the surviving handler compares the caller against the second
    // window and returns without reloading anything.
    expect(first.webContents.reload).toHaveBeenCalledTimes(1)
  })

  it('still reloads the second window after it attaches', async () => {
    const first = createWindowStub(1)
    const second = createWindowStub(2)
    attach(first)
    attach(second)

    await liveHandler('app:reload')?.({ sender: second.webContents } as never)

    expect(second.webContents.reload).toHaveBeenCalledTimes(1)
  })

  it('still answers the first window a pending TCC prompt after a second window attaches', async () => {
    const first = createWindowStub(1)
    const second = createWindowStub(2)
    attach(first)
    attach(second)

    const notice = await liveHandler('macosTccPrompts:consumePending')?.({
      sender: first.webContents
    } as never)

    // Today this resolves to null — the first window is told there is no prompt rather than being
    // told it may not ask, so the caller cannot tell the difference.
    expect(notice).not.toBeNull()
  })

  it('delivers a file drop back to the window it was dropped on', () => {
    const first = createWindowStub(1)
    const second = createWindowStub(2)
    attach(first)
    attach(second)

    liveListener('terminal:file-dropped-from-preload')?.(
      { sender: first.webContents } as never,
      { paths: ['/tmp/dropped.txt'], target: 'terminal' } as never
    )

    // Today the drop is discarded: the relay registered for the first window was removed wholesale,
    // and the one that replaced it only answers the second window.
    expect(first.webContents.send).toHaveBeenCalledWith('terminal:file-drop', {
      paths: ['/tmp/dropped.txt'],
      target: 'terminal'
    })
    expect(second.webContents.send).not.toHaveBeenCalled()
  })

  it('keeps the first window reloadable after the second window closes', async () => {
    const first = createWindowStub(1)
    const second = createWindowStub(2)
    attach(first)
    attach(second)

    for (const [event, handler] of second.on.mock.calls) {
      if (event === 'closed') {
        ;(handler as () => void)()
      }
    }

    await liveHandler('app:reload')?.({ sender: first.webContents } as never)

    expect(first.webContents.reload).toHaveBeenCalledTimes(1)
  })
})
