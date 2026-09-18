import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'

// A mobile driver's clientId is that phone's pairing bearer token. The renderer is an observer of
// who drives a terminal; it must learn which device, never the credential that device pairs with.

const { handleMock, onMock, setPermissionRequestHandlerMock, setPermissionCheckHandlerMock } =
  vi.hoisted(() => ({
    handleMock: vi.fn(),
    onMock: vi.fn(),
    setPermissionRequestHandlerMock: vi.fn(),
    setPermissionCheckHandlerMock: vi.fn()
  }))

vi.mock('electron', () => ({
  app: {},
  clipboard: {},
  systemPreferences: {
    askForMediaAccess: vi.fn().mockResolvedValue(true),
    getMediaAccessStatus: vi.fn().mockReturnValue('granted')
  },
  ipcMain: {
    on: onMock,
    removeAllListeners: vi.fn(),
    removeListener: vi.fn(),
    removeHandler: vi.fn(),
    handle: handleMock
  },
  powerMonitor: { on: vi.fn(), off: vi.fn() }
}))
vi.mock('../ipc/repos', () => ({
  registerRepoHandlers: vi.fn(),
  setRepoRemoteClientNotifier: vi.fn()
}))
vi.mock('../ipc/worktrees', () => ({ registerWorktreeHandlers: vi.fn() }))
vi.mock('../ipc/worktree-change-invalidators', () => ({ runWorktreeChangeInvalidators: vi.fn() }))
vi.mock('../ipc/pty', () => ({ getLocalPtyProvider: vi.fn(), registerPtyHandlers: vi.fn() }))
vi.mock('../memory/hydrate-local-pty-registry', () => ({
  hydrateLocalPtyRegistryAtBoot: vi.fn()
}))
vi.mock('../browser/browser-manager', () => ({ browserManager: { unregisterAll: vi.fn() } }))
vi.mock('../updater', () => ({
  checkForUpdates: vi.fn(),
  getUpdateStatus: vi.fn(),
  quitAndInstall: vi.fn(),
  dismissNudge: vi.fn(),
  setupAutoUpdater: vi.fn()
}))
vi.mock('../macos-tcc-prompt-notice', () => ({
  acknowledgePendingTccPromptNotice: vi.fn(),
  consumePendingTccPromptNotice: vi.fn().mockReturnValue({ claimId: 7 }),
  dismissTccPromptNotice: vi.fn(),
  releasePendingTccPromptNotice: vi.fn()
}))

import { attachMainWindowServices } from './attach-main-window-services'
import { resetWindowServiceIpcRouterForTest } from './window-service-ipc-router'

type DriverNotifier = {
  terminalDriverChanged: (ptyId: string, driver: { kind: string; clientId?: string }) => void
}

function attachAndCaptureNotifier(send: ReturnType<typeof vi.fn>): DriverNotifier {
  const window = {
    id: 1,
    isDestroyed: vi.fn(() => false),
    on: vi.fn(),
    once: vi.fn(),
    webContents: {
      id: 1,
      getURL: vi.fn(() => 'file:///opt/orca/renderer/index.html'),
      isDestroyed: vi.fn(() => false),
      isLoadingMainFrame: vi.fn(() => true),
      on: vi.fn(),
      send,
      reload: vi.fn(),
      session: {
        setPermissionRequestHandler: setPermissionRequestHandlerMock,
        setPermissionCheckHandler: setPermissionCheckHandlerMock
      }
    }
  }
  const setNotifier = vi.fn()
  const runtime = {
    attachWindow: vi.fn(),
    setNotifier,
    markRendererReloading: vi.fn(),
    markRendererReloadCancelled: vi.fn(),
    markGraphReloadFailed: vi.fn(),
    markGraphUnavailable: vi.fn()
  }
  const store = {
    getProfileStorageDirectory: vi.fn(() => '/profile-a'),
    flushPendingAsync: vi.fn(() => Promise.resolve())
  } as unknown as Store
  attachMainWindowServices(window as never, store, runtime as never, undefined, undefined, {})
  return setNotifier.mock.calls[0][0] as DriverNotifier
}

describe('attachMainWindowServices: terminal driver egress', () => {
  beforeEach(() => {
    handleMock.mockReset()
    onMock.mockReset()
    resetWindowServiceIpcRouterForTest()
  })

  it('forwards a terminal driver change without the driving phone pairing token', () => {
    const send = vi.fn()
    const notifier = attachAndCaptureNotifier(send)
    const phoneToken = 'd4'.repeat(24)

    notifier.terminalDriverChanged('pty-1', { kind: 'mobile', clientId: phoneToken })
    notifier.terminalDriverChanged('pty-1', { kind: 'desktop' })

    const driverSends = send.mock.calls.filter(
      ([channel]) => channel === 'runtime:terminalDriverChanged'
    )
    expect(JSON.stringify(driverSends)).not.toContain(phoneToken)
    expect(driverSends).toEqual([
      [
        'runtime:terminalDriverChanged',
        {
          ptyId: 'pty-1',
          driver: { kind: 'mobile', clientId: expect.stringMatching(/^observed:[0-9a-f]{32}$/) }
        }
      ],
      ['runtime:terminalDriverChanged', { ptyId: 'pty-1', driver: { kind: 'desktop' } }]
    ])
  })
})
