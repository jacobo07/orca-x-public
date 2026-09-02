/**
 * Who may type into a terminal, once more than one project window exists.
 *
 * Admission was `event.sender === mainWebContents`: the window these handlers were registered for
 * could write every PTY in the process, and no other window could write any. Both halves are wrong
 * with two windows — the second window cannot type into its own terminals, and the first window can
 * type into the second window's. The second half is the security-relevant one, and it fails open.
 */
import { describe, expect, it, vi } from 'vitest'
import { spawnMock } from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import {
  PTY_IPC_TEST_FOREIGN_WEB_CONTENTS_ID,
  PTY_IPC_TEST_MAIN_WEB_CONTENTS_ID
} from './pty-ipc-suite-environment'
import {
  registerAppWindowRenderer,
  resetAppWindowRendererRegistryForTest
} from './app-window-renderer-registry'
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

describe('pty input ownership across windows', () => {
  const {
    handlers,
    mainWindow,
    mainWindowIpcEvent,
    foreignWindowIpcEvent,
    createMockProc,
    getPtyWriteListener
  } = setupPtyIpcSuite()

  /** Spawn a PTY attributed to one window, with both windows registered as real project windows. */
  async function spawnOwnedBy(event: unknown): Promise<string> {
    resetAppWindowRendererRegistryForTest()
    registerAppWindowRenderer(PTY_IPC_TEST_MAIN_WEB_CONTENTS_ID)
    registerAppWindowRenderer(PTY_IPC_TEST_FOREIGN_WEB_CONTENTS_ID)
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)
    registerPtyHandlers(mainWindow as never)
    const result = (await handlers.get('pty:spawn')!(event, { cols: 80, rows: 24 })) as {
      id: string
    }
    return result.id
  }

  it('lets the window that owns a terminal write to it', async () => {
    const ptyId = await spawnOwnedBy(foreignWindowIpcEvent)
    const proc = spawnMock.mock.results.at(-1)?.value as { write: ReturnType<typeof vi.fn> }

    handlers.get('pty:writeAccepted')!(foreignWindowIpcEvent, { id: ptyId, data: 'x' })

    // The owning window is not the window these handlers were registered for, so the old gate
    // rejected it and its own terminal was read-only.
    expect(proc.write).toHaveBeenCalledWith('x')
  })

  it('refuses a write from a window that does not own the terminal', async () => {
    const ptyId = await spawnOwnedBy(foreignWindowIpcEvent)
    const proc = spawnMock.mock.results.at(-1)?.value as { write: ReturnType<typeof vi.fn> }

    const accepted = handlers.get('pty:writeAccepted')!(mainWindowIpcEvent, {
      id: ptyId,
      data: 'x'
    })

    // The fail-open half: the registration window used to be able to type into every terminal in
    // the process, including one belonging to another project's window.
    expect(accepted).toBe(false)
    expect(proc.write).not.toHaveBeenCalled()
  })

  it('applies the same ownership rule to the fire-and-forget write channel', async () => {
    const ptyId = await spawnOwnedBy(foreignWindowIpcEvent)
    const proc = spawnMock.mock.results.at(-1)?.value as { write: ReturnType<typeof vi.fn> }
    const write = getPtyWriteListener()

    // `pty:write` is `ipcMain.on`, so it answers nothing and a wrong admission is invisible from
    // the renderer. It has to carry the same gate as the acknowledged channel.
    write(mainWindowIpcEvent, { id: ptyId, data: 'y' })
    expect(proc.write).not.toHaveBeenCalled()

    write(foreignWindowIpcEvent, { id: ptyId, data: 'y' })
    expect(proc.write).toHaveBeenCalledWith('y')
  })

  it('still admits the registering window for a terminal with no recorded owner', async () => {
    const ptyId = await spawnOwnedBy(null)
    const proc = spawnMock.mock.results.at(-1)?.value as { write: ReturnType<typeof vi.fn> }

    // Main spawns terminals itself for background and runtime-owned work, and those arrive with no
    // sender to attribute. Refusing them would make restored and daemon-adopted terminals unusable.
    handlers.get('pty:writeAccepted')!(mainWindowIpcEvent, { id: ptyId, data: 'z' })

    expect(proc.write).toHaveBeenCalledWith('z')
  })
})
