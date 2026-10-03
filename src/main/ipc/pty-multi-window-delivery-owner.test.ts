/**
 * A PTY's output follows the PTY, not the newest window registration (R-05).
 *
 * `registerPtyHandlers` runs once per window and rebinds the provider listeners to the newest
 * closure. Every send guarded by that closure's `mainWindow.isDestroyed()` used to drop or wipe
 * the output of every other window's PTY once the newest window closed. Each test names the
 * window that must receive the send and never accepts a union with the closed one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { onMock, spawnMock } from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { getPtyRendererDeliveryDebugSnapshot, registerPtyHandlers } from './pty'
import {
  registerAppWindowRenderer,
  unregisterAppWindowRenderer
} from './app-window-renderer-registry'

const electronState = vi.hoisted(() => ({
  webContentsById: new Map<number, unknown>(),
  windowByWebContents: new Map<unknown, unknown>()
}))

vi.mock('electron', async () => {
  const base = await import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock())
  return {
    ...base,
    BrowserWindow: {
      fromWebContents: (contents: unknown) =>
        electronState.windowByWebContents.get(contents) ?? null
    },
    webContents: {
      // Why throws: Electron 43 rejects a non-number id instead of answering null.
      fromId: (id: unknown) => {
        if (typeof id !== 'number') {
          throw new TypeError('Error processing argument at index 0, conversion failure')
        }
        return electronState.webContentsById.get(id) ?? null
      }
    }
  }
})
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
  isDestroyed: () => boolean
}

type MockWindow = {
  isDestroyed: () => boolean
  isFocused: () => boolean
  isVisible: () => boolean
  isMinimized: () => boolean
  webContents: MockWebContents
}

describe('pty delivery follows the owning window after the newest window closes', () => {
  const {
    handlers,
    mainWindow,
    mainWindowIpcEvent,
    foreignWindowIpcEvent,
    createMockProc,
    installDaemonTestProvider
  } = setupPtyIpcSuite()

  const closed = new Set<number>()
  let first: MockWindow
  let second: MockWindow

  function connect(window: MockWindow): void {
    electronState.webContentsById.set(window.webContents.id, window.webContents)
    electronState.windowByWebContents.set(window.webContents, window)
    registerAppWindowRenderer(window.webContents.id)
  }

  /** Window teardown as Electron reports it: ids stop resolving, the registry forgets it, `destroyed` fires. */
  function close(window: MockWindow, options?: { destroyedEventPending: boolean }): void {
    const { webContents } = window
    closed.add(webContents.id)
    electronState.webContentsById.delete(webContents.id)
    unregisterAppWindowRenderer(webContents.id)
    if (options?.destroyedEventPending) {
      return
    }
    const destroyed = webContents.on.mock.calls.findLast((c: unknown[]) => c[0] === 'destroyed')
    ;(destroyed?.[1] as (() => void) | undefined)?.()
  }

  beforeEach(() => {
    closed.clear()
    electronState.webContentsById.clear()
    electronState.windowByWebContents.clear()
    const firstContents = mainWindow.webContents as unknown as MockWebContents
    firstContents.isDestroyed = () => closed.has(firstContents.id)
    mainWindow.isDestroyed = () => closed.has(firstContents.id)
    first = mainWindow as unknown as MockWindow
    const secondContents = foreignWindowIpcEvent.sender as unknown as MockWebContents
    secondContents.on.mockReset()
    secondContents.send.mockReset()
    secondContents.removeListener.mockReset()
    secondContents.isDestroyed = () => closed.has(secondContents.id)
    second = {
      isDestroyed: () => closed.has(secondContents.id),
      isFocused: () => false,
      isVisible: () => true,
      isMinimized: () => false,
      webContents: secondContents
    }
    connect(first)
  })

  afterEach(() => {
    unregisterAppWindowRenderer(first.webContents.id)
    unregisterAppWindowRenderer(second.webContents.id)
  })

  /** Why findLast: a re-registration replaces ipcMain listeners; the harness accessors return the first. */
  function latestIpcListener<T>(channel: string): T {
    const call = onMock.mock.calls.findLast((c: unknown[]) => c[0] === channel)
    if (!call) {
      throw new Error(`missing ${channel} listener`)
    }
    return call[1] as T
  }

  function handshake(webContents: MockWebContents): void {
    latestIpcListener<(event: unknown) => void>('pty:rendererDispatcherReady')({
      sender: webContents
    })
  }

  function sendsOn(window: MockWindow, channel: string): unknown[] {
    return window.webContents.send.mock.calls
      .filter((c: unknown[]) => c[0] === channel)
      .map((c: unknown[]) => c[1])
  }

  /** Window A registers and owns a visible local PTY; window B registers after it and handshakes. */
  async function visibleTerminalInFirstThenSecondWindow(): Promise<{
    id: string
    proc: ReturnType<typeof createMockProc>
  }> {
    const proc = createMockProc()
    spawnMock.mockReturnValue(proc.proc)
    registerPtyHandlers(first as never)
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
    connect(second)
    registerPtyHandlers(second as never)
    handshake(second.webContents)
    vi.advanceTimersByTime(2)
    first.webContents.send.mockClear()
    second.webContents.send.mockClear()
    return { id, proc }
  }

  it('data: output emitted after the newest window closed reaches the owner', async () => {
    vi.useFakeTimers()
    try {
      const { id, proc } = await visibleTerminalInFirstThenSecondWindow()

      close(second)
      proc.emitData('after the newer window closed')
      vi.advanceTimersByTime(2)

      expect(sendsOn(first, 'pty:data')).toEqual([{ id, data: 'after the newer window closed' }])
      expect(sendsOn(second, 'pty:data')).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('flush: output batched before the newest window closed is flushed to the owner', async () => {
    vi.useFakeTimers()
    try {
      const { id, proc } = await visibleTerminalInFirstThenSecondWindow()

      proc.emitData('queued while both windows lived')
      // Why no `destroyed` yet: its lifecycle reset clears pending output for every PTY, which would hide the flush guard.
      close(second, { destroyedEventPending: true })
      vi.advanceTimersByTime(2)

      expect(sendsOn(first, 'pty:data')).toEqual([{ id, data: 'queued while both windows lived' }])
      expect(sendsOn(second, 'pty:data')).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('exit: a PTY that exits after the newest window closed tells its owner', async () => {
    vi.useFakeTimers()
    try {
      const { id, proc } = await visibleTerminalInFirstThenSecondWindow()

      close(second)
      proc.emitExit(0)
      vi.advanceTimersByTime(2)

      expect(sendsOn(first, 'pty:exit')).toMatchObject([{ id, code: 0 }])
      expect(sendsOn(second, 'pty:exit')).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('serialize: a snapshot request after the newest window closed goes to the owner', async () => {
    vi.useFakeTimers()
    try {
      const runtime = {
        setPtyController: vi.fn(),
        onPtySpawned: vi.fn(),
        onPtyData: vi.fn(),
        onPtyExit: vi.fn(),
        preAllocateHandleForPty: vi.fn()
      }
      const proc = createMockProc()
      spawnMock.mockReturnValue(proc.proc)
      registerPtyHandlers(first as never, runtime as never)
      const { id } = (await handlers.get('pty:spawn')!(mainWindowIpcEvent, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      connect(second)
      registerPtyHandlers(second as never, runtime as never)
      const controller = runtime.setPtyController.mock.calls.at(-1)?.[0] as {
        serializeBuffer: (ptyId: string) => Promise<unknown>
      }
      first.webContents.send.mockClear()
      second.webContents.send.mockClear()

      close(second)
      const pending = controller.serializeBuffer(id)
      const requests = sendsOn(first, 'pty:serializeBuffer:request') as { requestId: string }[]
      expect(requests).toHaveLength(1)
      expect(sendsOn(second, 'pty:serializeBuffer:request')).toEqual([])
      latestIpcListener<(e: unknown, a: unknown) => void>('pty:serializeBuffer:response')(null, {
        requestId: requests[0].requestId,
        snapshot: { data: 'screen', cols: 80, rows: 24 }
      })
      await expect(pending).resolves.toMatchObject({ data: 'screen' })
    } finally {
      vi.useRealTimers()
    }
  })

  /** A daemon-style provider whose stream listeners the test can fire; the newest registration binds last. */
  function installObservableProvider(): {
    writeUnavailable: () => ((payload: { id: string }) => void) | null
    backgroundStream: () => ((payload: unknown) => void) | null
  } {
    let writeUnavailable: ((payload: { id: string }) => void) | null = null
    let backgroundStream: ((payload: unknown) => void) | null = null
    installDaemonTestProvider({
      onWriteUnavailable: vi.fn((handler: (payload: { id: string }) => void) => {
        writeUnavailable = handler
        return () => {}
      }),
      onBackgroundStreamEvent: vi.fn((handler: (payload: unknown) => void) => {
        backgroundStream = handler
        return () => {}
      })
    })
    return { writeUnavailable: () => writeUnavailable, backgroundStream: () => backgroundStream }
  }

  async function daemonTerminalInFirstThenSecondWindow(sessionId: string): Promise<{
    id: string
    provider: ReturnType<typeof installObservableProvider>
  }> {
    const provider = installObservableProvider()
    registerPtyHandlers(first as never)
    const { id } = (await handlers.get('pty:spawn')!(mainWindowIpcEvent, {
      cols: 80,
      rows: 24,
      sessionId
    })) as { id: string }
    connect(second)
    registerPtyHandlers(second as never)
    handshake(second.webContents)
    first.webContents.send.mockClear()
    second.webContents.send.mockClear()
    return { id, provider }
  }

  it('write unavailable: the provider signal after the newest window closed reaches the owner', async () => {
    vi.useFakeTimers()
    try {
      const { id, provider } = await daemonTerminalInFirstThenSecondWindow('owner-wu')

      close(second)
      provider.writeUnavailable()?.({ id })

      expect(sendsOn(first, 'pty:writeUnavailable')).toEqual([{ id }])
      expect(sendsOn(second, 'pty:writeUnavailable')).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('restore routing: a model-restore marker goes to the owner while the newest window lives', async () => {
    vi.useFakeTimers()
    try {
      const { id, provider } = await daemonTerminalInFirstThenSecondWindow('owner-restore')

      provider.backgroundStream()?.({ id, kind: 'dataGap', droppedChars: 512 })

      expect(sendsOn(first, 'pty:modelRestoreNeeded')).toEqual([{ id, reason: 'hidden-drop' }])
      expect(sendsOn(second, 'pty:modelRestoreNeeded')).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('resync routing: the delivery resync probe for a gated PTY goes to the owner', async () => {
    vi.useFakeTimers()
    try {
      const { proc } = await visibleTerminalInFirstThenSecondWindow()

      // Unacknowledged output past the per-PTY in-flight cap gates the PTY and triggers the probe.
      for (let chunk = 0; chunk < 8; chunk += 1) {
        proc.emitData('x'.repeat(100_000))
        vi.advanceTimersByTime(2)
      }
      // Why more rounds: a flush sends at most two writes, so the queued bytes drain over several.
      for (let round = 0; round < 10; round += 1) {
        vi.advanceTimersByTime(2)
      }
      proc.emitData('one more')
      vi.advanceTimersByTime(2)

      expect(sendsOn(first, 'pty:requestDeliveryResync')).toHaveLength(1)
      expect(sendsOn(second, 'pty:requestDeliveryResync')).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('control: with every window closed nothing is sent and the pending output is wiped', async () => {
    vi.useFakeTimers()
    try {
      const { proc } = await visibleTerminalInFirstThenSecondWindow()

      proc.emitData('queued')
      expect(getPtyRendererDeliveryDebugSnapshot().pendingChars).toBeGreaterThan(0)
      close(second)
      close(first)
      proc.emitData('after the last window closed')
      vi.advanceTimersByTime(2)

      expect(sendsOn(first, 'pty:data')).toEqual([])
      expect(sendsOn(second, 'pty:data')).toEqual([])
      expect(getPtyRendererDeliveryDebugSnapshot().pendingChars).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
