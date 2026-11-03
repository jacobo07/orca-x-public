import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnMock } from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { createDaemonActiveProviderFixtures } from './pty-ipc-daemon-provider-fixtures'
import { registerPtyHandlers, registerSshPtyProvider } from './pty'
import {
  resetTrustedWorkerDispatchIdsForTest,
  trustWorkerDispatchId,
  WORKER_DISPATCH_ID_ENV
} from '../runtime/orchestration/worker-dispatch-env'

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

const MINTED = 'ctx_minted_dispatch'
const SPOOFED = 'ctx_spoofed_dispatch'

function sshProvider(spawn: ReturnType<typeof vi.fn>): never {
  return {
    spawn,
    write: vi.fn(),
    resize: vi.fn(),
    shutdown: vi.fn(),
    sendSignal: vi.fn(),
    getCwd: vi.fn(),
    getInitialCwd: vi.fn(),
    clearBuffer: vi.fn(),
    onData: vi.fn(() => () => {}),
    onReplay: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {}),
    listProcesses: vi.fn(),
    hasChildProcesses: vi.fn(),
    getForegroundProcess: vi.fn(),
    serialize: vi.fn(),
    revive: vi.fn(),
    getDefaultShell: vi.fn(),
    getProfiles: vi.fn(),
    acknowledgeDataEvent: vi.fn()
  } as never
}

describe('ORCA_WORKER_DISPATCH_ID on PTY spawns (K2)', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()
  const { daemonSpawnAndGetOptions } = createDaemonActiveProviderFixtures({ handlers, mainWindow })

  afterEach(() => {
    resetTrustedWorkerDispatchIdsForTest()
  })

  const localRuntime = () => ({
    setPtyController: vi.fn(),
    noteTerminalSpawnCommand: vi.fn(),
    preAllocateHandleForPty: vi.fn(() => 'term_local'),
    onPtySpawned: vi.fn(),
    onPtyExit: vi.fn(),
    onPtyData: vi.fn()
  })

  async function localSpawnEnv(env: Record<string, string>): Promise<Record<string, string>> {
    registerPtyHandlers(mainWindow as never, localRuntime() as never)
    await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24, env })
    return spawnMock.mock.calls.at(-1)![2].env as Record<string, string>
  }

  it('keeps a minted id on a local spawn and removes a spoofed one', async () => {
    trustWorkerDispatchId(MINTED)
    expect(
      (await localSpawnEnv({ [WORKER_DISPATCH_ID_ENV]: MINTED }))[WORKER_DISPATCH_ID_ENV]
    ).toBe(MINTED)
    expect(
      (await localSpawnEnv({ [WORKER_DISPATCH_ID_ENV]: SPOOFED }))[WORKER_DISPATCH_ID_ENV]
    ).toBeUndefined()
  })

  it('leaves an ordinary local terminal untagged', async () => {
    expect((await localSpawnEnv({ EXISTING: '1' }))[WORKER_DISPATCH_ID_ENV]).toBeUndefined()
  })

  it('removes an id inherited by this process unless it was minted', async () => {
    const previous = process.env[WORKER_DISPATCH_ID_ENV]
    process.env[WORKER_DISPATCH_ID_ENV] = SPOOFED
    try {
      expect((await localSpawnEnv({ EXISTING: '1' }))[WORKER_DISPATCH_ID_ENV]).toBeUndefined()
    } finally {
      if (previous === undefined) {
        delete process.env[WORKER_DISPATCH_ID_ENV]
      } else {
        process.env[WORKER_DISPATCH_ID_ENV] = previous
      }
    }
  })

  it('applies the same rule to IPC env on an SSH connection spawn', async () => {
    const spawn = vi.fn(async () => ({ id: 'remote-pty' }))
    registerSshPtyProvider('ssh-k2', sshProvider(spawn))
    const runtime = {
      setPtyController: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term_remote'),
      registerPreAllocatedHandleForPty: vi.fn()
    }
    registerPtyHandlers(mainWindow as never, runtime as never)
    trustWorkerDispatchId(MINTED)
    const sshEnv = async (value: string): Promise<Record<string, string>> => {
      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        connectionId: 'ssh-k2',
        env: { [WORKER_DISPATCH_ID_ENV]: value }
      })
      return (spawn.mock.calls.at(-1)! as unknown as [{ env: Record<string, string> }])[0].env
    }

    expect((await sshEnv(MINTED))[WORKER_DISPATCH_ID_ENV]).toBe(MINTED)
    expect((await sshEnv(SPOOFED))[WORKER_DISPATCH_ID_ENV]).toBeUndefined()
  })

  it('asks the daemon to delete an untrusted or inherited id, and keeps a minted one', async () => {
    trustWorkerDispatchId(MINTED)
    const minted = (await daemonSpawnAndGetOptions({ [WORKER_DISPATCH_ID_ENV]: MINTED })) as {
      env: Record<string, string>
      envToDelete?: string[]
    }
    expect(minted.env[WORKER_DISPATCH_ID_ENV]).toBe(MINTED)
    expect(minted.envToDelete ?? []).not.toContain(WORKER_DISPATCH_ID_ENV)

    const spoofed = (await daemonSpawnAndGetOptions({ [WORKER_DISPATCH_ID_ENV]: SPOOFED })) as {
      env: Record<string, string>
      envToDelete?: string[]
    }
    expect(spoofed.env[WORKER_DISPATCH_ID_ENV]).toBeUndefined()
    expect(spoofed.envToDelete).toContain(WORKER_DISPATCH_ID_ENV)

    const plain = (await daemonSpawnAndGetOptions({})) as { envToDelete?: string[] }
    expect(plain.envToDelete).toContain(WORKER_DISPATCH_ID_ENV)
  })

  it('applies the rule on the runtime controller spawn that worker terminals use', async () => {
    const spawn = vi.fn(async () => ({ id: 'controller-pty' }))
    registerSshPtyProvider('ssh-controller', sshProvider(spawn))
    const setPtyController = vi.fn()
    const runtime = {
      setPtyController,
      noteTerminalSpawnCommand: vi.fn(),
      registerPreAllocatedHandleForPty: vi.fn()
    }
    registerPtyHandlers(mainWindow as never, runtime as never)
    const controller = setPtyController.mock.calls.at(-1)![0] as {
      spawn: (args: Record<string, unknown>) => Promise<unknown>
    }
    trustWorkerDispatchId(MINTED)
    const options = async (
      env: Record<string, string>
    ): Promise<{ env: Record<string, string>; envToDelete?: string[] }> => {
      await controller.spawn({ cols: 80, rows: 24, connectionId: 'ssh-controller', env })
      return (
        spawn.mock.calls.at(-1)! as unknown as [
          { env: Record<string, string>; envToDelete?: string[] }
        ]
      )[0]
    }

    const minted = await options({ [WORKER_DISPATCH_ID_ENV]: MINTED })
    expect(minted.env[WORKER_DISPATCH_ID_ENV]).toBe(MINTED)
    expect(minted.envToDelete ?? []).not.toContain(WORKER_DISPATCH_ID_ENV)

    const spoofed = await options({ [WORKER_DISPATCH_ID_ENV]: SPOOFED })
    expect(spoofed.env[WORKER_DISPATCH_ID_ENV]).toBeUndefined()
    expect(spoofed.envToDelete).toContain(WORKER_DISPATCH_ID_ENV)

    // Why: a relay or daemon that inherited a tag must drop it for an ordinary terminal.
    const plain = await options({ EXISTING: '1' })
    expect(plain.envToDelete).toContain(WORKER_DISPATCH_ID_ENV)
  })
})
