/**
 * The renderer lifecycle reset belongs to the window whose page died (D6,
 * docs/reference/pty-multi-window-lifecycle-reset.md).
 *
 * It ran on every registerPtyHandlers call, so opening a second window hid every terminal of the
 * first one, and it moved the reload/crash listeners to the newest window. Real app: the first
 * window's terminal stopped rendering output the moment a second window opened.
 */
import { describe, expect, it, vi } from 'vitest'
import { onMock, spawnMock } from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { registerPtyHandlers } from './pty'

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

const LIFECYCLE_EVENTS = ['did-start-navigation', 'render-process-gone', 'destroyed']

describe('pty renderer lifecycle reset with two windows', () => {
  const { handlers, mainWindow, mainWindowIpcEvent, foreignWindowIpcEvent, createMockProc } =
    setupPtyIpcSuite()

  /** Why findLast: a re-registration replaces ipcMain listeners; the harness accessors return the first. */
  function latestIpcListener<T>(channel: string): T {
    const call = onMock.mock.calls.findLast((c: unknown[]) => c[0] === channel)
    if (!call) {
      throw new Error(`missing ${channel} listener`)
    }
    return call[1] as T
  }

  function lifecycleListener(webContents: MockWebContents, event: string): (arg?: unknown) => void {
    const call = webContents.on.mock.calls.findLast((c: unknown[]) => c[0] === event)
    if (!call) {
      throw new Error(`window ${webContents.id} has no ${event} listener`)
    }
    return call[1] as (arg?: unknown) => void
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

  function ptyDataSends(...windows: MockWebContents[]): unknown[] {
    return windows.flatMap((wc) =>
      wc.send.mock.calls.filter((c: unknown[]) => c[0] === 'pty:data').map((c: unknown[]) => c[1])
    )
  }

  /** Window A owns a visible terminal; then window B opens and its page handshakes. */
  async function twoWindowsWithVisibleTerminalInFirst(): Promise<{
    id: string
    proc: ReturnType<typeof createMockProc>
    second: { webContents: MockWebContents }
  }> {
    const proc = createMockProc()
    spawnMock.mockReturnValue(proc.proc)
    registerPtyHandlers(mainWindow as never)
    const { id } = (await handlers.get('pty:spawn')!(mainWindowIpcEvent, {
      cols: 80,
      rows: 24,
      cwd: '/tmp'
    })) as { id: string }
    latestIpcListener<(e: unknown, a: unknown) => void>('pty:setRendererPtyVisible')(
      mainWindowIpcEvent,
      { id, visible: true }
    )
    vi.advanceTimersByTime(2)

    const second = secondWindow()
    registerPtyHandlers(second as never)
    handshake(second.webContents)
    vi.advanceTimersByTime(2)
    mainWindow.webContents.send.mockClear()
    second.webContents.send.mockClear()
    return { id, proc, second }
  }

  /** A page's dispatcher-ready handshake, sent from that page's own webContents. */
  function handshake(webContents: MockWebContents): void {
    latestIpcListener<(event: unknown) => void>('pty:rendererDispatcherReady')({
      sender: webContents
    })
  }

  function reloadPage(webContents: MockWebContents): void {
    lifecycleListener(
      webContents,
      'did-start-navigation'
    )({
      isMainFrame: true,
      isSameDocument: false
    })
  }

  it('C1: opening a second window leaves the first window terminal in the foreground', async () => {
    vi.useFakeTimers()
    try {
      const { id, proc, second } = await twoWindowsWithVisibleTerminalInFirst()

      proc.emitData('survivor output')
      vi.advanceTimersByTime(2)

      // Pre-fix: the registration reset cleared visibility, so this went out as background: true.
      expect(ptyDataSends(mainWindow.webContents, second.webContents)).toEqual([
        { id, data: 'survivor output' }
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('C2: the first window keeps its reload/crash listeners after a second window opens', async () => {
    vi.useFakeTimers()
    try {
      const first = mainWindow.webContents as MockWebContents
      const proc = createMockProc()
      spawnMock.mockReturnValue(proc.proc)
      first.on.mockClear()
      registerPtyHandlers(mainWindow as never)
      const { id } = (await handlers.get('pty:spawn')!(mainWindowIpcEvent, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      latestIpcListener<(e: unknown, a: unknown) => void>('pty:setRendererPtyVisible')(
        mainWindowIpcEvent,
        { id, visible: true }
      )
      const listenersOf = (event: string): unknown[] =>
        first.on.mock.calls.filter((c: unknown[]) => c[0] === event).map((c: unknown[]) => c[1])
      // Why identity, not event name: the hidden-gate reset also listens on render-process-gone and is still newest-window-only (recorded debt).
      const owned = Object.fromEntries(LIFECYCLE_EVENTS.map((e) => [e, listenersOf(e)]))
      first.removeListener.mockClear()

      const second = secondWindow()
      registerPtyHandlers(second as never)
      handshake(second.webContents)

      const removed = new Set(first.removeListener.mock.calls.map((c: unknown[]) => c[1]))
      const surviving = (event: string): unknown[] =>
        (owned[event] as unknown[]).filter((fn) => !removed.has(fn))
      expect(surviving('did-start-navigation')).toEqual(owned['did-start-navigation'])
      expect(surviving('destroyed')).toEqual(owned.destroyed)
      // The crash listener that survived is the lifecycle reset: firing it sends the first window's terminal to the background.
      for (const onGone of surviving('render-process-gone')) {
        ;(onGone as () => void)()
      }
      first.send.mockClear()
      second.webContents.send.mockClear()
      proc.emitData('after the first window crashed')
      vi.advanceTimersByTime(10_008)
      expect(ptyDataSends(first, second.webContents)).toEqual([
        { id, data: 'after the first window crashed', background: true }
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it("C3: the second window's reload leaves the first window terminal in the foreground", async () => {
    vi.useFakeTimers()
    try {
      const { id, proc, second } = await twoWindowsWithVisibleTerminalInFirst()

      reloadPage(second.webContents)
      handshake(second.webContents)
      proc.emitData('after the other window reloaded')
      vi.advanceTimersByTime(2)

      expect(ptyDataSends(mainWindow.webContents, second.webContents)).toEqual([
        { id, data: 'after the other window reloaded' }
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it("C3-negative: the first window's own reload still sends its terminal to the background", async () => {
    vi.useFakeTimers()
    try {
      const { id, proc, second } = await twoWindowsWithVisibleTerminalInFirst()

      reloadPage(mainWindow.webContents as MockWebContents)
      proc.emitData('while its own page reloads')
      // Why the watchdog, not a handshake: this control must hold before and after C5.
      vi.advanceTimersByTime(10_008)

      // Control: the reset still works for the window whose page died — fail closed until it reports.
      expect(ptyDataSends(mainWindow.webContents, second.webContents)).toEqual([
        { id, data: 'while its own page reloads', background: true }
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it("C5: the older window's new page reopens delivery without waiting for the watchdog", async () => {
    vi.useFakeTimers()
    try {
      const { id, proc, second } = await twoWindowsWithVisibleTerminalInFirst()

      reloadPage(mainWindow.webContents as MockWebContents)
      handshake(mainWindow.webContents as MockWebContents)
      proc.emitData('after its own reload')
      vi.advanceTimersByTime(8)

      // Pre-fix: only the newest window's handshake counted, so this sat until the 10 s watchdog.
      expect(ptyDataSends(mainWindow.webContents, second.webContents)).toEqual([
        { id, data: 'after its own reload', background: true }
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('C5-negative: a handshake from a window that was not reset is still refused', async () => {
    vi.useFakeTimers()
    try {
      const { proc, second } = await twoWindowsWithVisibleTerminalInFirst()

      reloadPage(second.webContents)
      // The first window's page did not reset; its handshake must not reopen the gate.
      handshake(mainWindow.webContents as MockWebContents)
      proc.emitData('held until the reloading page answers')
      vi.advanceTimersByTime(8)

      expect(ptyDataSends(mainWindow.webContents, second.webContents)).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('C6: closing the second window keeps the first window terminal delivering in the foreground', async () => {
    vi.useFakeTimers()
    try {
      const { id, proc, second } = await twoWindowsWithVisibleTerminalInFirst()

      lifecycleListener(second.webContents, 'destroyed')()
      proc.emitData('after the other window closed')
      vi.advanceTimersByTime(8)

      // No page will ever handshake for a closed window; holding until the 10 s watchdog freezes survivors.
      expect(ptyDataSends(mainWindow.webContents, second.webContents)).toEqual([
        { id, data: 'after the other window closed' }
      ])
    } finally {
      vi.useRealTimers()
    }
  })
})
