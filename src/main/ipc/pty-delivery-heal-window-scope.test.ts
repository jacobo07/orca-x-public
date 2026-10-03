/**
 * R-05-H / docs/reference/pty-multi-window-lifecycle-reset.md C10: a renderer's heal report judges only the PTYs whose
 * output is delivered to that renderer. A PTY another window owns is unknown to the reporter, never "received 0".
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

const SATURATED_IN_FLIGHT_CHARS = 512 * 1024
const SATURATED_PENDING_CHARS = 88 * 1024

describe('pty delivery heal report is scoped to the reporting window', () => {
  const { handlers, mainWindow, mainWindowIpcEvent, foreignWindowIpcEvent, createMockProc } =
    setupPtyIpcSuite()

  let first: MockWindow
  let second: MockWindow

  function connect(window: MockWindow): void {
    electronState.webContentsById.set(window.webContents.id, window.webContents)
    electronState.windowByWebContents.set(window.webContents, window)
    registerAppWindowRenderer(window.webContents.id)
  }

  beforeEach(() => {
    electronState.webContentsById.clear()
    electronState.windowByWebContents.clear()
    const firstContents = mainWindow.webContents as unknown as MockWebContents
    firstContents.isDestroyed = () => false
    first = mainWindow as unknown as MockWindow
    const secondContents = foreignWindowIpcEvent.sender as unknown as MockWebContents
    secondContents.on.mockReset()
    secondContents.send.mockReset()
    secondContents.removeListener.mockReset()
    secondContents.isDestroyed = () => false
    second = {
      isDestroyed: () => false,
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

  function latestIpcListener<T>(channel: string): T {
    const call = onMock.mock.calls.findLast((c: unknown[]) => c[0] === channel)
    if (!call) {
      throw new Error(`missing ${channel} listener`)
    }
    return call[1] as T
  }

  type HealReply = {
    inFlightTotalChars: number
    writtenOff?: { id: string; markerSeq?: number; writtenOffChars: number }[]
  }

  function report(event: unknown, args: Record<string, unknown>): HealReply {
    return handlers.get('pty:reportRendererDeliveryState')!(event, {
      processedCharsByPty: {},
      heal: true,
      rendererPtyDataListenerCount: 1,
      ...args
    }) as HealReply
  }

  async function spawnFrom(event: unknown): Promise<string> {
    const { id } = (await handlers.get('pty:spawn')!(event, {
      cols: 80,
      rows: 24,
      cwd: '/tmp'
    })) as { id: string }
    return id
  }

  /** Both windows registered, handshaken, each owning one PTY saturated to its per-PTY credit with pending output behind it. */
  async function twoWindowsEachWithAWedgedPty(): Promise<{ x: string; y: string }> {
    const procA = createMockProc()
    const procB = createMockProc()
    spawnMock.mockReturnValueOnce(procA.proc).mockReturnValueOnce(procB.proc)
    registerPtyHandlers(first as never)
    const x = await spawnFrom(mainWindowIpcEvent)
    connect(second)
    registerPtyHandlers(second as never)
    latestIpcListener<(event: unknown) => void>('pty:rendererDispatcherReady')({
      sender: second.webContents
    })
    const y = await spawnFrom(foreignWindowIpcEvent)
    procA.emitData('x'.repeat(600 * 1024))
    procB.emitData('y'.repeat(600 * 1024))
    for (let index = 0; index < 40; index++) {
      vi.advanceTimersByTime(1)
    }
    return { x, y }
  }

  it("a window's heal report writes off its own PTY and leaves another window's in-flight PTY alone", async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // Arrange
      const { x, y } = await twoWindowsEachWithAWedgedPty()
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 2 * SATURATED_IN_FLIGHT_CHARS,
        pendingChars: 2 * SATURATED_PENDING_CHARS,
        pendingDroppedChars: 0
      })

      // Act: window A names only X; Y is B's and unknown to A.
      const healed = report(mainWindowIpcEvent, { receivedCharsByPty: { [x]: 0 } })

      // Assert
      expect(healed.writtenOff).toEqual([{ id: x, writtenOffChars: SATURATED_IN_FLIGHT_CHARS }])
      expect(healed.writtenOff?.some((entry) => entry.id === y)).toBe(false)
      expect(healed.inFlightTotalChars).toBe(SATURATED_IN_FLIGHT_CHARS)
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: SATURATED_IN_FLIGHT_CHARS,
        pendingChars: SATURATED_PENDING_CHARS,
        pendingDroppedChars: SATURATED_PENDING_CHARS
      })
    } finally {
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it("symmetry: the other window's heal report writes off only its own PTY", async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // Arrange
      const { x, y } = await twoWindowsEachWithAWedgedPty()

      // Act: window B reports nothing received; X is A's and unknown to B.
      const healed = report(foreignWindowIpcEvent, { receivedCharsByPty: {} })

      // Assert
      expect(healed.writtenOff).toEqual([{ id: y, writtenOffChars: SATURATED_IN_FLIGHT_CHARS }])
      expect(healed.writtenOff?.some((entry) => entry.id === x)).toBe(false)
      expect(healed.inFlightTotalChars).toBe(SATURATED_IN_FLIGHT_CHARS)
    } finally {
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('control: with one window, its report omitting its own PTY still writes it off (single-window behaviour)', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // Arrange
      const proc = createMockProc()
      spawnMock.mockReturnValueOnce(proc.proc)
      registerPtyHandlers(first as never)
      const only = await spawnFrom(mainWindowIpcEvent)
      proc.emitData('x'.repeat(600 * 1024))
      for (let index = 0; index < 40; index++) {
        vi.advanceTimersByTime(1)
      }

      // Act
      const healed = report(mainWindowIpcEvent, { receivedCharsByPty: {} })

      // Assert
      expect(healed.writtenOff).toEqual([{ id: only, writtenOffChars: SATURATED_IN_FLIGHT_CHARS }])
      expect(healed.inFlightTotalChars).toBe(0)
    } finally {
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })
})
