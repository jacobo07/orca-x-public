import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { prepareCodexSessionResume } from '../codex/codex-session-resume-preparation'
import { registerPtyHandlers, setLocalPtyProvider, type PrepareCodexSessionResume } from './pty'

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

type ControllerSpawnResult = { id: string; agentResumeUnavailable?: true }
type CapturedController = {
  spawn?: (opts: Record<string, unknown>) => Promise<ControllerSpawnResult>
}

describe('runtime pty controller Codex resume honesty', () => {
  const { mainWindow } = setupPtyIpcSuite()

  const RESUME_SESSION_ID = '019f81b9-19a9-7651-a8d1-352d9420bd11'
  const ORIGIN_HOME = '/managed/origin/home'
  const OTHER_HOME = '/managed/other/home'
  const ORIGIN_ROLLOUT = `${ORIGIN_HOME}/sessions/2026/07/20/rollout-2026-07-20T12-00-00-${RESUME_SESSION_ID}.jsonl`

  // Why the real preparation: the drop decision under test is the production one, so the only
  // variable is whether the controller reports the outcome it already computed.
  const prepareResumeWithTrustedHomes =
    (trustedHomes: readonly string[]): PrepareCodexSessionResume =>
    ({ providerSession }) =>
      prepareCodexSessionResume({
        sessionId: providerSession.id,
        transcriptPath: providerSession.transcriptPath,
        trustedCodexHomes: trustedHomes,
        getSelectedAccountCodexHome: () => null,
        systemCodexHomePath: null,
        sharedRuntimeCodexHomePath: null,
        fileIsRegular: () => true,
        resolveVerifiedResumeHome: async (source) => source.homePath
      })

  function captureController(): CapturedController {
    const captured: CapturedController = {}
    const runtime = {
      setPtyController: (controller: CapturedController) => {
        captured.spawn = controller.spawn
      }
    }
    setLocalPtyProvider({
      spawn: vi.fn(async (options: { sessionId?: string }) => ({
        id: options.sessionId ?? 'controller-pty'
      })),
      supportsGitCredentialGuardHost: () => true,
      supportsAgentSessionClaims: () => true,
      supportsAgentSessionCreateOperations: () => true,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      shutdown: vi.fn(),
      onData: vi.fn(() => vi.fn()),
      onExit: vi.fn(() => vi.fn()),
      listProcesses: vi.fn(async () => []),
      getForegroundProcess: vi.fn(async () => null)
    } as never)
    registerPtyHandlers(
      mainWindow as never,
      runtime as never,
      vi.fn(() => OTHER_HOME),
      undefined,
      undefined,
      undefined,
      { prepareCodexSessionResume: prepareResumeWithTrustedHomes([OTHER_HOME]) }
    )
    return captured
  }

  it('reports the dropped resume so a runtime pane cannot claim it resumed', async () => {
    const controller = captureController()
    expect(controller.spawn, 'controller was never registered with the runtime').toBeDefined()

    const spawned = await controller.spawn!({
      cols: 80,
      rows: 24,
      cwd: '/tmp',
      command: `codex 'resume' '${RESUME_SESSION_ID}'`,
      launchAgent: 'codex',
      resumeProviderSession: {
        key: 'session_id',
        id: RESUME_SESSION_ID,
        transcriptPath: ORIGIN_ROLLOUT
      }
    })

    // The desktop path already reports this. A relay or headless pane runs the same drop and then
    // starts a fresh session while telling the user nothing, which presents a restart as a resume.
    expect(
      spawned.agentResumeUnavailable,
      'runtime controller launched a fresh session without reporting the resume was unavailable'
    ).toBe(true)
  })

  it('stays silent when the resume was never dropped', async () => {
    const controller = captureController()
    const spawned = await controller.spawn!({
      cols: 80,
      rows: 24,
      cwd: '/tmp',
      command: 'codex',
      launchAgent: 'codex'
    })

    expect(spawned.agentResumeUnavailable).toBeUndefined()
  })
})
