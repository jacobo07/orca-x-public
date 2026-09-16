import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { LocalPtyProvider } from '../providers/local-pty-provider'
import { LiveSessionMaterializationReservations } from '../agent-hooks/live-session-materialization-reservation'
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

const LEAF = '11111111-1111-4111-8111-111111111111'
const SESSION = { key: 'session_id' as const, id: 'claude-session-s' }
const RESUME_COMMAND = 'claude --resume claude-session-s'

describe('pty:spawn resume of a session another operation is starting', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()

  it('characterization: hands the resume to the provider although the session is reserved', async () => {
    const reservations = new LiveSessionMaterializationReservations({
      now: () => 0,
      hasBoundPty: () => false
    })
    // An AI Vault resume in another window holds S and has not reported yet.
    expect(reservations.tryAcquire('claim:claude-session-s', 'op-vault', 2)).toBe('granted')
    const providerSpawn = vi.spyOn(LocalPtyProvider.prototype, 'spawn')

    registerPtyHandlers(mainWindow as never)
    // A sleep launch / cold restore of the same session spawns its pane.
    const result = await handlers.get('pty:spawn')!(
      { sender: { id: 1 } },
      {
        cols: 80,
        rows: 24,
        worktreeId: 'worktree-a',
        tabId: 'tab-sleep',
        leafId: LEAF,
        command: RESUME_COMMAND,
        launchAgent: 'claude',
        resumeProviderSession: SESSION
      }
    )

    expect(providerSpawn.mock.calls.at(-1)?.[0]).toMatchObject({ command: RESUME_COMMAND })
    expect(result).not.toHaveProperty('agentResumeRefused')
    expect(reservations.holder('claim:claude-session-s')?.operationId).toBe('op-vault')
  })
})
