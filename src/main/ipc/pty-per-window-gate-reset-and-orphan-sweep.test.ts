/**
 * CONTEXT A2 / docs/reference/pty-multi-window-lifecycle-reset.md C8: every window keeps its own hidden-gate reset and orphan sweep.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { webContents as electronWebContents } from 'electron'
import { onMock, spawnMock } from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import {
  registerHeadlessPtyRuntime,
  registerPtyHandlers,
  releasePtyRendererOwnershipForWindow
} from './pty'
import { getHiddenRendererPtyDeliveryDebug, isHiddenRendererPty } from './pty-hidden-delivery-gate'
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

type MockWebContents = {
  id: number
  on: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  removeListener: ReturnType<typeof vi.fn>
}

describe('pty hidden-gate reset and orphan sweep with two windows', () => {
  const {
    handlers,
    mainWindow,
    mainWindowIpcEvent,
    foreignWindowIpcEvent,
    createMockProc,
    installObservableDaemonTestProvider
  } = setupPtyIpcSuite()
  const first = mainWindow.webContents as MockWebContents

  beforeEach(() => {
    // Why: ownership is module-level and outlives each test's PTYs.
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

  function listenersOf(webContents: MockWebContents, event: string): (() => void)[] {
    return webContents.on.mock.calls
      .filter((c: unknown[]) => c[0] === event)
      .map((c: unknown[]) => c[1] as () => void)
  }

  /** Listeners still attached: registered on this webContents and never passed to its removeListener. */
  function surviving(webContents: MockWebContents, event: string): (() => void)[] {
    const removed = new Set(
      webContents.removeListener.mock.calls
        .filter((c: unknown[]) => c[0] === event)
        .map((c: unknown[]) => c[1])
    )
    return listenersOf(webContents, event).filter((fn) => !removed.has(fn))
  }

  function fireSurviving(webContents: MockWebContents, event: string): void {
    for (const listener of surviving(webContents, event)) {
      listener()
    }
  }

  async function spawnFrom(event: unknown, sessionId?: string): Promise<string> {
    const { id } = (await handlers.get('pty:spawn')!(event, {
      cols: 80,
      rows: 24,
      cwd: '/tmp',
      ...(sessionId ? { sessionId } : {})
    })) as { id: string }
    return id
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

  /** Daemon provider: no orphan sweep, so did-finish-load means gate reset only. */
  async function twoDaemonWindowsWithHiddenPtys(tag: string): Promise<{
    pa: string
    pb: string
    second: { webContents: MockWebContents }
  }> {
    installObservableDaemonTestProvider()
    registerPtyHandlers(mainWindow as never)
    const pa = await spawnFrom(mainWindowIpcEvent, `${tag}-a`)
    const second = secondWindow()
    registerPtyHandlers(second as never)
    const pb = await spawnFrom(foreignWindowIpcEvent, `${tag}-b`)
    markHidden(mainWindowIpcEvent, pa)
    markHidden(foreignWindowIpcEvent, pb)
    return { pa, pb, second }
  }

  function markHidden(event: unknown, id: string): void {
    latestIpcListener<(e: unknown, a: { id: string; hidden: boolean }) => void>(
      'pty:setHiddenRendererPty'
    )(event, { id, hidden: true })
  }

  function holdInterest(event: unknown, id: string): void {
    latestIpcListener<(e: unknown, a: { id: string; interested: boolean }) => void>(
      'pty:setPtyDeliveryInterest'
    )(event, { id, interested: true })
  }

  it("tracer: the first window's reload clears its own hidden mark after a second window opened", async () => {
    // Arrange
    registerPtyHandlers(mainWindow as never)
    const pa = await spawnFrom(mainWindowIpcEvent)
    markHidden(mainWindowIpcEvent, pa)
    registerPtyHandlers(secondWindow() as never)

    // Act
    fireSurviving(first, 'did-finish-load')

    // Assert
    expect(isHiddenRendererPty(pa)).toBe(false)
  })
  /** Both windows open: a dead owner's PTYs are reset by anyone, so "the other window's" needs it live. */
  function fireWithBothWindowsLive(webContents: MockWebContents, event: string): void {
    withLiveRenderers(
      [PTY_IPC_TEST_MAIN_WEB_CONTENTS_ID, PTY_IPC_TEST_FOREIGN_WEB_CONTENTS_ID],
      () => fireSurviving(webContents, event)
    )
  }

  it("scope: the second window's reload clears only its own hidden marks", async () => {
    // Arrange
    const { pa, pb, second } = await twoDaemonWindowsWithHiddenPtys('scope')

    // Act
    fireWithBothWindowsLive(second.webContents, 'did-finish-load')

    // Assert
    expect(isHiddenRendererPty(pa)).toBe(true)
    expect(isHiddenRendererPty(pb)).toBe(false)
  })

  it("crash: the first window's render-process-gone clears its marks after a second window opened", async () => {
    // Arrange
    const { pa, pb } = await twoDaemonWindowsWithHiddenPtys('crash')

    // Act
    fireWithBothWindowsLive(first, 'render-process-gone')

    // Assert
    expect(isHiddenRendererPty(pa)).toBe(false)
    expect(isHiddenRendererPty(pb)).toBe(true)
  })

  function extraWindow(id: number): { webContents: MockWebContents } {
    return {
      isDestroyed: () => false,
      isFocused: () => false,
      isVisible: () => true,
      isMinimized: () => false,
      webContents: { id, on: vi.fn(), send: vi.fn(), removeListener: vi.fn() }
    } as never
  }

  it("opening: a new window's first load keeps the unowned PTY state a live window set (C1)", async () => {
    // Arrange
    installObservableDaemonTestProvider()
    registerPtyHandlers(mainWindow as never)
    const unowned = await spawnFrom(null, 'opening-u')
    markHidden(mainWindowIpcEvent, unowned)
    holdInterest(mainWindowIpcEvent, unowned)
    const opening = extraWindow(3)
    registerPtyHandlers(opening as never)
    const openingEvent = { sender: opening.webContents }
    const own = await spawnFrom(openingEvent, 'opening-own')
    markHidden(openingEvent, own)
    expect(getHiddenRendererPtyDeliveryDebug().deliveryInterestPtyCount).toBe(1)

    // Act
    withLiveRenderers([PTY_IPC_TEST_MAIN_WEB_CONTENTS_ID, 3], () =>
      fireSurviving(opening.webContents, 'did-finish-load')
    )

    // Assert
    expect(isHiddenRendererPty(unowned)).toBe(true)
    expect(getHiddenRendererPtyDeliveryDebug().deliveryInterestPtyCount).toBe(1)
    // Control: the reset ran — the opening window's own mark went.
    expect(isHiddenRendererPty(own)).toBe(false)
  })

  it('headless: a window opened beside the headless runtime survives its first load (CR-01)', async () => {
    // Arrange: `orca serve` registers a webContents with no id, then promotes to a desktop window.
    installObservableDaemonTestProvider()
    registerHeadlessPtyRuntime(undefined as never)
    const opened = extraWindow(5)
    registerPtyHandlers(opened as never)
    const unowned = await spawnFrom(null, 'headless-u')
    markHidden(null, unowned)
    const mocked = electronWebContents as unknown as { fromId: (id: unknown) => unknown }
    const original = mocked.fromId
    // Why: Electron's fromId throws on a non-number id.
    mocked.fromId = (id) => {
      if (typeof id !== 'number') {
        throw new TypeError('Error processing argument at index 0, conversion failure from undefined')
      }
      return id === 5 ? { isDestroyed: () => false } : null
    }

    try {
      // Act + Assert
      expect(() => fireSurviving(opened.webContents, 'did-finish-load')).not.toThrow()
    } finally {
      mocked.fromId = original
    }

    // Assert: the headless host is no live window, so this lone first load clears unowned leftovers.
    expect(isHiddenRendererPty(unowned)).toBe(false)
  })

  it('lone window: a first load with no other live window still clears unowned leftovers', async () => {
    // Arrange: every earlier window reads as closed.
    installObservableDaemonTestProvider()
    const lone = extraWindow(4)
    registerPtyHandlers(lone as never)
    const unowned = await spawnFrom(null, 'lone-u')
    markHidden(null, unowned)
    holdInterest(null, unowned)

    // Act
    withLiveRenderers([4], () => fireSurviving(lone.webContents, 'did-finish-load'))

    // Assert
    expect(isHiddenRendererPty(unowned)).toBe(false)
    expect(getHiddenRendererPtyDeliveryDebug().deliveryInterestPtyCount).toBe(0)
  })

  it("unowned: either window's reload clears an unowned PTY's hidden mark (fail closed)", async () => {
    // Arrange
    const { pa, second } = await twoDaemonWindowsWithHiddenPtys('unowned')
    // Why primed: a window's first load is not a reload and keeps unowned state (C1).
    fireWithBothWindowsLive(first, 'did-finish-load')
    fireWithBothWindowsLive(second.webContents, 'did-finish-load')
    markHidden(mainWindowIpcEvent, pa)
    const unowned = await spawnFrom(null, 'unowned-u')
    markHidden(null, unowned)

    // Act + Assert: the second window's reload
    fireWithBothWindowsLive(second.webContents, 'did-finish-load')
    expect(isHiddenRendererPty(unowned)).toBe(false)
    // Control: a PTY the first window owns is not the second window's to clear.
    expect(isHiddenRendererPty(pa)).toBe(true)

    // Act + Assert: the first window's reload
    markHidden(null, unowned)
    fireWithBothWindowsLive(first, 'did-finish-load')
    expect(isHiddenRendererPty(unowned)).toBe(false)
  })

  it.each(['did-finish-load', 'render-process-gone'])(
    "dead owner: after the owning window closed, the other window's %s clears its surviving PTY's mark and interest",
    async (event) => {
      // Arrange: the daemon PTY outlives its window (close is a Detach).
      const { pa, second } = await twoDaemonWindowsWithHiddenPtys(`dead-owner-${event}`)
      holdInterest(mainWindowIpcEvent, pa)
      fireSurviving(first, 'destroyed')
      // Control: closing the window alone leaves both entries in place.
      expect(isHiddenRendererPty(pa)).toBe(true)
      expect(getHiddenRendererPtyDeliveryDebug().deliveryInterestPtyCount).toBe(1)

      // Act
      withLiveRenderers([PTY_IPC_TEST_FOREIGN_WEB_CONTENTS_ID], () =>
        fireSurviving(second.webContents, event)
      )

      // Assert
      expect(isHiddenRendererPty(pa)).toBe(false)
      expect(getHiddenRendererPtyDeliveryDebug().deliveryInterestPtyCount).toBe(0)
    }
  )

  it("sweep: the first window's reload kills its own orphaned local PTY after a second window opened", async () => {
    // Arrange
    const procA = createMockProc()
    const procB = createMockProc()
    // Why held here: termination neutralizes proc.kill on the process object.
    const killA = procA.proc.kill
    const killB = procB.proc.kill
    spawnMock.mockReturnValueOnce(procA.proc)
    registerPtyHandlers(mainWindow as never)
    await spawnFrom(mainWindowIpcEvent)
    registerPtyHandlers(secondWindow() as never)
    spawnMock.mockReturnValueOnce(procB.proc)
    await spawnFrom(foreignWindowIpcEvent)

    // Act: the first load only advances the generation; the second sweeps the earlier load's PTYs.
    withLiveRenderers([PTY_IPC_TEST_FOREIGN_WEB_CONTENTS_ID], () => {
      fireSurviving(first, 'did-finish-load')
      fireSurviving(first, 'did-finish-load')
    })

    // Assert
    expect(killA).toHaveBeenCalled()
    // Spare: the live second window still owns its PTY.
    expect(killB).not.toHaveBeenCalled()
  })

  it('destroy: closing a window removes its gate-reset and sweep listeners', () => {
    // Arrange
    registerPtyHandlers(mainWindow as never)
    // Control: the window holds the lifecycle gone listener, the gate-reset gone listener, and gate-reset + sweep loads.
    expect(listenersOf(first, 'did-finish-load')).toHaveLength(2)
    expect(listenersOf(first, 'render-process-gone')).toHaveLength(2)

    // Act
    fireSurviving(first, 'destroyed')

    // Assert
    expect(surviving(first, 'did-finish-load')).toEqual([])
    expect(surviving(first, 'render-process-gone')).toEqual([])
  })

  it('re-registration: registering a window again replaces its gate-reset and sweep listeners', () => {
    // Arrange
    registerPtyHandlers(mainWindow as never)
    const previous = listenersOf(first, 'did-finish-load')

    // Act
    registerPtyHandlers(mainWindow as never)

    // Assert
    const remaining = surviving(first, 'did-finish-load')
    expect(remaining).toHaveLength(2)
    expect(remaining.filter((fn) => previous.includes(fn))).toEqual([])
  })
})
