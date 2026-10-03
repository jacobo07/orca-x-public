import { beforeEach, describe, expect, it, vi } from 'vitest'
import { webContents as electronWebContents } from 'electron'
import { onMock } from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { registerPtyHandlers, releasePtyRendererOwnershipForWindow } from './pty'
import {
  _resetHiddenRendererPtyDeliveryGateForTest,
  getHiddenRendererPtyDeliveryDebug,
  isHiddenRendererPty,
  shouldDropHiddenRendererPtyData
} from './pty-hidden-delivery-gate'
import {
  PTY_IPC_TEST_FOREIGN_WEB_CONTENTS_ID,
  PTY_IPC_TEST_MAIN_WEB_CONTENTS_ID
} from './pty-ipc-suite-environment'

vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../opencode/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../agent-hooks/server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../pi/titlebar-extension-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../pwsh', () => import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../wsl', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../telemetry/client', () =>
  import('./pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../telemetry/classify-error', () =>
  import('./pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../cli/linux-terminal-orca-cli-shim', () =>
  import('./pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../memory/pty-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../codex/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../codex/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

/**
 * R-P1-WR02 / docs/reference/pty-multi-window-lifecycle-reset.md C8: a window's reload or crash withdraws only the
 * hidden marks and delivery-interest holds that window (or a dead or unattributed setter) made.
 */
type MockWebContents = {
  id: number
  on: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  removeListener: ReturnType<typeof vi.fn>
}

describe('pty hidden marks and interest holds are attributed to the window that set them', () => {
  const {
    handlers,
    mainWindow,
    mainWindowIpcEvent,
    foreignWindowIpcEvent,
    installObservableDaemonTestProvider
  } = setupPtyIpcSuite()
  const first = mainWindow.webContents as MockWebContents
  const BOTH_LIVE = [PTY_IPC_TEST_MAIN_WEB_CONTENTS_ID, PTY_IPC_TEST_FOREIGN_WEB_CONTENTS_ID]

  beforeEach(() => {
    // Why: gate and ownership state are module-level and outlive each test's PTYs.
    _resetHiddenRendererPtyDeliveryGateForTest()
    releasePtyRendererOwnershipForWindow(PTY_IPC_TEST_MAIN_WEB_CONTENTS_ID)
    releasePtyRendererOwnershipForWindow(PTY_IPC_TEST_FOREIGN_WEB_CONTENTS_ID)
  })

  /** Why findLast: a re-registration replaces ipcMain listeners; the harness accessors return the first. */
  function latestIpcListener<T>(channel: string): T {
    const call = onMock.mock.calls.findLast((c: unknown[]) => c[0] === channel)
    if (!call) {
      throw new Error(`missing ${channel} listener`)
    }
    return call[1] as T
  }

  function markHidden(event: unknown, id: string, hidden = true): void {
    latestIpcListener<(e: unknown, a: { id: string; hidden: boolean }) => void>(
      'pty:setHiddenRendererPty'
    )(event, { id, hidden })
  }

  function holdInterest(event: unknown, id: string, interested = true): void {
    latestIpcListener<(e: unknown, a: { id: string; interested: boolean }) => void>(
      'pty:setPtyDeliveryInterest'
    )(event, { id, interested })
  }

  function secondWindow(): { webContents: MockWebContents } {
    const webContents = foreignWindowIpcEvent.sender as MockWebContents
    webContents.on.mockReset()
    webContents.send.mockReset()
    webContents.removeListener.mockReset()
    return {
      isDestroyed: () => false,
      isFocused: () => false,
      isVisible: () => true,
      isMinimized: () => false,
      webContents
    } as never
  }

  function fireSurviving(webContents: MockWebContents, event: string): void {
    const removed = new Set(
      webContents.removeListener.mock.calls
        .filter((c: unknown[]) => c[0] === event)
        .map((c: unknown[]) => c[1])
    )
    for (const call of webContents.on.mock.calls) {
      if (call[0] === event && !removed.has(call[1])) {
        ;(call[1] as () => void)()
      }
    }
  }

  /** Why: the electron mock resolves no renderer, so every liveness check would read every window as dead. */
  function withLiveRenderers(webContentsIds: readonly number[], act: () => void): void {
    const mocked = electronWebContents as unknown as { fromId: (id: number) => unknown }
    const original = mocked.fromId
    mocked.fromId = (id) => (webContentsIds.includes(id) ? { isDestroyed: () => false } : null)
    try {
      act()
    } finally {
      mocked.fromId = original
    }
  }

  async function spawnUnowned(sessionId: string): Promise<string> {
    const { id } = (await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      cwd: '/tmp',
      sessionId
    })) as { id: string }
    return id
  }

  /** Both windows registered and past their first load, so a second load is a genuine reload. */
  function twoLoadedWindows(): { second: { webContents: MockWebContents } } {
    installObservableDaemonTestProvider()
    registerPtyHandlers(mainWindow as never)
    const second = secondWindow()
    registerPtyHandlers(second as never)
    withLiveRenderers(BOTH_LIVE, () => {
      fireSurviving(first, 'did-finish-load')
      fireSurviving(second.webContents, 'did-finish-load')
    })
    return { second }
  }

  /** Window A holds a gate-only PTY (hidden, droppable) and a held PTY (hidden plus interest) on unowned PTYs. */
  async function windowAMarksUnownedPtys(
    tag: string
  ): Promise<{ hiddenOnly: string; held: string }> {
    const hiddenOnly = await spawnUnowned(`${tag}-hidden`)
    const held = await spawnUnowned(`${tag}-held`)
    markHidden(mainWindowIpcEvent, hiddenOnly)
    markHidden(mainWindowIpcEvent, held)
    holdInterest(mainWindowIpcEvent, held)
    return { hiddenOnly, held }
  }

  function expectWindowAStateSurvived(ptys: { hiddenOnly: string; held: string }): void {
    expect(isHiddenRendererPty(ptys.hiddenOnly)).toBe(true)
    expect(isHiddenRendererPty(ptys.held)).toBe(true)
    expect(getHiddenRendererPtyDeliveryDebug().deliveryInterestPtyCount).toBe(1)
    // The drop decision still follows A's marks: dropped without a hold, kept with one.
    expect(shouldDropHiddenRendererPtyData(ptys.hiddenOnly, undefined)).toBe(true)
    expect(shouldDropHiddenRendererPtyData(ptys.held, undefined)).toBe(false)
  }

  it.each([
    ['reload', 'did-finish-load'],
    ['crash', 'render-process-gone']
  ])(
    "%s: the second window's reset keeps the live first window's marks and holds on unowned PTYs",
    async (_name, event) => {
      // Arrange
      const { second } = twoLoadedWindows()
      const ptys = await windowAMarksUnownedPtys(`wr02-${event}`)
      expectWindowAStateSurvived(ptys)

      // Act
      withLiveRenderers(BOTH_LIVE, () => fireSurviving(second.webContents, event))

      // Assert
      expectWindowAStateSurvived(ptys)
    }
  )

  it("own: the second window's reload still clears the marks and holds it set itself", async () => {
    // Arrange
    const { second } = twoLoadedWindows()
    const hiddenOnly = await spawnUnowned('own-hidden')
    const held = await spawnUnowned('own-held')
    markHidden(foreignWindowIpcEvent, hiddenOnly)
    markHidden(foreignWindowIpcEvent, held)
    holdInterest(foreignWindowIpcEvent, held)
    expect(getHiddenRendererPtyDeliveryDebug().deliveryInterestPtyCount).toBe(1)

    // Act
    withLiveRenderers(BOTH_LIVE, () => fireSurviving(second.webContents, 'did-finish-load'))

    // Assert
    expect(isHiddenRendererPty(hiddenOnly)).toBe(false)
    expect(isHiddenRendererPty(held)).toBe(false)
    expect(getHiddenRendererPtyDeliveryDebug().deliveryInterestPtyCount).toBe(0)
  })

  it("dead setter: a closed window's marks and holds on an unowned PTY are cleared by another window's reload", async () => {
    // Arrange
    const { second } = twoLoadedWindows()
    const ptys = await windowAMarksUnownedPtys('dead')
    fireSurviving(first, 'destroyed')
    // Control: closing the window alone leaves its entries in place.
    expect(isHiddenRendererPty(ptys.held)).toBe(true)

    // Act
    withLiveRenderers([PTY_IPC_TEST_FOREIGN_WEB_CONTENTS_ID], () =>
      fireSurviving(second.webContents, 'did-finish-load')
    )

    // Assert
    expect(isHiddenRendererPty(ptys.hiddenOnly)).toBe(false)
    expect(isHiddenRendererPty(ptys.held)).toBe(false)
    expect(getHiddenRendererPtyDeliveryDebug().deliveryInterestPtyCount).toBe(0)
  })

  it("unattributed: a mark and hold with no sender are cleared by any window's reload (fail closed)", async () => {
    // Arrange
    const { second } = twoLoadedWindows()
    const ptyId = await spawnUnowned('unattributed')
    markHidden(null, ptyId)
    holdInterest(null, ptyId)
    expect(getHiddenRendererPtyDeliveryDebug().deliveryInterestPtyCount).toBe(1)

    // Act
    withLiveRenderers(BOTH_LIVE, () => fireSurviving(second.webContents, 'did-finish-load'))

    // Assert
    expect(isHiddenRendererPty(ptyId)).toBe(false)
    expect(getHiddenRendererPtyDeliveryDebug().deliveryInterestPtyCount).toBe(0)
  })

  it("last writer: another window's unmark still clears the hidden bit", async () => {
    // Arrange
    twoLoadedWindows()
    const ptyId = await spawnUnowned('last-writer')
    markHidden(mainWindowIpcEvent, ptyId)
    expect(isHiddenRendererPty(ptyId)).toBe(true)

    // Act
    markHidden(foreignWindowIpcEvent, ptyId, false)

    // Assert
    expect(isHiddenRendererPty(ptyId)).toBe(false)
  })

  it("hold ownership: one window releasing its hold keeps another window's hold", async () => {
    // Arrange
    twoLoadedWindows()
    const ptyId = await spawnUnowned('hold-ownership')
    markHidden(mainWindowIpcEvent, ptyId)
    holdInterest(mainWindowIpcEvent, ptyId)
    holdInterest(foreignWindowIpcEvent, ptyId)

    // Act
    holdInterest(foreignWindowIpcEvent, ptyId, false)

    // Assert
    expect(getHiddenRendererPtyDeliveryDebug().deliveryInterestPtyCount).toBe(1)
    expect(shouldDropHiddenRendererPtyData(ptyId, undefined)).toBe(false)

    // Act + Assert: the last holder releasing lifts the suppression.
    holdInterest(mainWindowIpcEvent, ptyId, false)
    expect(shouldDropHiddenRendererPtyData(ptyId, undefined)).toBe(true)
  })
})
