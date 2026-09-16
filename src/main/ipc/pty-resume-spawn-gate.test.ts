import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { LocalPtyProvider } from '../providers/local-pty-provider'
import { LiveSessionMaterializationReservations } from '../agent-hooks/live-session-materialization-reservation'
import {
  installResumeSpawnGate,
  type ResumeSpawnRequest
} from '../agent-hooks/resume-spawn-gate-slot'
import { SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV } from '../../shared/setup-agent-sequencing'
import { decideResumeSpawn } from './agent-session-resume-spawn-gate'
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
const KEY = 'claim:claude-session-s'
const RESUME_COMMAND = 'claude --resume claude-session-s'
const VAULT_WINDOW = 2
const SPAWN_WINDOW = 1

function installGate(reservations: LiveSessionMaterializationReservations) {
  const decide = vi.fn(({ sender, ...request }: ResumeSpawnRequest) =>
    decideResumeSpawn(
      {
        listHookRows: () => [],
        isObservedInCurrentRuntime: () => true,
        resolveIdentityKey: async ({ providerSession }) => `claim:${providerSession.id}`,
        getBoundPtyIdForPaneKey: () => undefined,
        getPersistedPtyIdForPaneKey: () => undefined,
        probePtyLiveness: async () => false
      },
      reservations,
      { ...request, ownerId: sender?.id ?? -1 },
      () => 'spawn-op'
    )
  )
  installResumeSpawnGate({
    decide,
    release: (operationId, sender) => reservations.release(operationId, sender?.id ?? -1)
  })
  return decide
}

describe('pty:spawn resume of a session another operation is starting', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()
  const sender = { id: SPAWN_WINDOW, once: vi.fn() }
  const resumeSpawn = (tabId: string, extra: Record<string, unknown> = {}) =>
    handlers.get('pty:spawn')!(
      { sender },
      {
        cols: 80,
        rows: 24,
        worktreeId: 'worktree-a',
        tabId,
        leafId: LEAF,
        command: RESUME_COMMAND,
        launchAgent: 'claude',
        resumeProviderSession: SESSION,
        ...extra
      }
    )
  let reservations: LiveSessionMaterializationReservations

  beforeEach(() => {
    reservations = new LiveSessionMaterializationReservations({
      now: () => 0,
      hasBoundPty: () => false
    })
  })
  afterEach(() => {
    installResumeSpawnGate(null)
  })

  it('starts a plain shell and says why when the session is already starting', async () => {
    installGate(reservations)
    // An AI Vault resume in another window holds S and has not reported yet.
    expect(reservations.tryAcquire(KEY, 'op-vault', VAULT_WINDOW)).toBe('granted')
    const providerSpawn = vi.spyOn(LocalPtyProvider.prototype, 'spawn')

    registerPtyHandlers(mainWindow as never)
    // A sleep launch / cold restore of the same session spawns its pane.
    const result = await resumeSpawn('tab-sleep', {
      env: { [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: RESUME_COMMAND, KEEP: '1' }
    })

    const spawnArgs = providerSpawn.mock.calls.at(-1)?.[0]
    expect(spawnArgs?.command).toBeUndefined()
    expect(spawnArgs?.launchAgent).toBeUndefined()
    expect(spawnArgs?.env?.[SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]).toBeUndefined()
    expect(spawnArgs?.env?.KEEP).toBe('1')
    expect(result).toMatchObject({ agentResumeRefused: 'materializing' })
    expect(result).not.toHaveProperty('launchConfig')
    expect(reservations.holder(KEY)?.operationId).toBe('op-vault')
  })

  it('resumes a free session and holds it for the tab it spawned', async () => {
    installGate(reservations)
    const providerSpawn = vi.spyOn(LocalPtyProvider.prototype, 'spawn')

    registerPtyHandlers(mainWindow as never)
    const result = await resumeSpawn('tab-restore')

    expect(providerSpawn.mock.calls.at(-1)?.[0]).toMatchObject({ command: RESUME_COMMAND })
    expect(result).not.toHaveProperty('agentResumeRefused')
    expect(reservations.holder(KEY)).toMatchObject({
      operationId: 'spawn-op',
      ownerId: SPAWN_WINDOW,
      tabId: 'tab-restore'
    })
  })

  it('gives the session back when the granted spawn fails', async () => {
    installGate(reservations)
    vi.spyOn(LocalPtyProvider.prototype, 'spawn').mockRejectedValueOnce(new Error('spawn failed'))

    registerPtyHandlers(mainWindow as never)
    // The suite's telemetry mock rethrows its own error; either way the spawn rejected.
    await expect(resumeSpawn('tab-restore')).rejects.toThrow()

    expect(reservations.holder(KEY)).toBeNull()
  })

  it('does not consult the gate for a spawn that resumes nothing', async () => {
    const decide = installGate(reservations)

    registerPtyHandlers(mainWindow as never)
    await resumeSpawn('tab-fresh', { resumeProviderSession: undefined, command: 'claude' })

    expect(decide).not.toHaveBeenCalled()
    expect(reservations.size).toBe(0)
  })
})
