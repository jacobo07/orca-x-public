import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { LiveSessionMaterializationReservations } from '../agent-hooks/live-session-materialization-reservation'
import {
  installResumeSpawnGate,
  type ResumeSpawnRequest
} from '../agent-hooks/resume-spawn-gate-slot'
import { agentSessionClaimKey } from '../../shared/claimed-agent-pty-owner-snapshot'
import type { LiveAgentSessionPresenceReaderDeps } from '../agent-hooks/live-agent-session-presence-reader'
import { decideResumeSpawn } from './agent-session-resume-spawn-gate'
import { clearProviderPtyState, setLocalPtyProvider } from './pty'

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

// Runtime ensure (web AI Vault, runtime-hosted panes) against the desktop reservation: one
// session, two main-side authorities that must be one.
describe('runtime ensure and the desktop materialization reservation', () => {
  const {
    createAgentClaimProvider,
    recoveredAgentClaim: claim,
    recoveredAgentSurface: surface,
    registerAgentClaimController
  } = setupPtyIpcSuite()
  const SESSION = { key: 'session_id' as const, id: 'codex-session-s' }
  const KEY = agentSessionClaimKey(claim)
  const PTY_ID = 'pty-runtime-ensure'
  const DESKTOP_WINDOW = 2
  let reservations: LiveSessionMaterializationReservations

  let gateDeps: LiveAgentSessionPresenceReaderDeps
  const desktopResume = (tabId: string) =>
    decideResumeSpawn(
      gateDeps,
      reservations,
      {
        worktreeId: surface.worktreeId,
        tabId,
        leafId: surface.leafId,
        agent: claim.agent,
        providerSession: SESSION,
        ownerId: DESKTOP_WINDOW
      },
      () => 'op-desktop-spawn'
    )
  const ensureRequest = {
    cols: 80,
    rows: 24,
    cwd: '/tmp/recovered-worktree',
    worktreeId: surface.worktreeId,
    agentSessionEnsure: { claim, surface },
    agentSessionResumeSubject: { agent: claim.agent, providerSession: SESSION }
  }
  const claimProvider = (spawn: () => Promise<{ id: string; incarnationId: string }>) => {
    const sessions: { id: string; incarnationId: string; cwd: string; title: string }[] = []
    const physicalSpawn = vi.fn(async () => {
      const result = await spawn()
      sessions.push({ ...result, cwd: '/tmp/recovered-worktree', title: 'Codex' })
      return result
    })
    const provider = createAgentClaimProvider({
      sessions,
      spawn: physicalSpawn,
      authoritativeOwnerListings: false
    })
    Object.assign(provider, { routesFreshSpawnsToLocalProvider: true })
    setLocalPtyProvider(provider as never)
    return physicalSpawn
  }

  beforeEach(() => {
    gateDeps = {
      listHookRows: () => [],
      isObservedInCurrentRuntime: () => true,
      resolveIdentityKey: async ({ providerSession }) =>
        providerSession.id === SESSION.id ? KEY : `other:${providerSession.id}`,
      getBoundPtyIdForPaneKey: () => undefined,
      getPersistedPtyIdForPaneKey: () => undefined,
      probePtyLiveness: async () => false
    }
    reservations = new LiveSessionMaterializationReservations({
      now: () => 0,
      hasBoundPty: () => false
    })
    installResumeSpawnGate({
      decide: ({ sender, ...request }: ResumeSpawnRequest) =>
        decideResumeSpawn(gateDeps, reservations, { ...request, ownerId: sender?.id ?? -1 }),
      release: (operationId, sender) => reservations.release(operationId, sender?.id ?? -1)
    })
  })
  afterEach(() => {
    installResumeSpawnGate(null)
    clearProviderPtyState(PTY_ID)
  })

  it('refuses a runtime ensure while a desktop resume holds the session', async () => {
    expect(reservations.tryAcquire(KEY, 'op-vault', DESKTOP_WINDOW)).toBe('granted')
    reservations.attachTab('op-vault', DESKTOP_WINDOW, 'tab-desktop')
    const physicalSpawn = claimProvider(async () => ({ id: PTY_ID, incarnationId: 'inc-a' }))
    const controller = registerAgentClaimController()

    await expect(controller.spawn(ensureRequest)).rejects.toThrow('agent_session_materializing')
    expect(physicalSpawn).not.toHaveBeenCalled()
    expect(reservations.holder(KEY)?.operationId).toBe('op-vault')
  })

  it('holds a free session for the ensured tab, and a retry adopts instead of contending', async () => {
    const physicalSpawn = claimProvider(async () => ({ id: PTY_ID, incarnationId: 'inc-c' }))
    const controller = registerAgentClaimController()

    await expect(controller.spawn(ensureRequest)).resolves.toMatchObject({
      agentSessionEnsure: { disposition: 'created' }
    })
    expect(reservations.holder(KEY)).toMatchObject({ ownerId: -1, tabId: surface.tabId })
    await expect(controller.spawn(ensureRequest)).resolves.toMatchObject({
      id: PTY_ID,
      agentSessionEnsure: { disposition: 'adopted' }
    })
    expect(physicalSpawn).toHaveBeenCalledOnce()
    expect(await desktopResume('tab-desktop')).toEqual({
      outcome: 'refused',
      reason: 'materializing'
    })
  })

  it('gives the session back when the admitted spawn fails', async () => {
    claimProvider(async () => {
      throw new Error('spawn failed')
    })
    const controller = registerAgentClaimController()

    await expect(controller.spawn(ensureRequest)).rejects.toThrow('spawn failed')
    expect(reservations.holder(KEY)).toBeNull()
  })

  it('refuses an ensure that cannot name its session, and one whose key presence cannot reproduce', async () => {
    const physicalSpawn = claimProvider(async () => ({ id: PTY_ID, incarnationId: 'inc-d' }))
    const controller = registerAgentClaimController()

    await expect(
      controller.spawn({ ...ensureRequest, agentSessionResumeSubject: undefined })
    ).rejects.toThrow('agent_session_presence_unknown')
    await expect(
      controller.spawn({
        ...ensureRequest,
        agentSessionEnsure: { claim: { ...claim, identityDigest: 'c'.repeat(43) }, surface }
      })
    ).rejects.toThrow('agent_session_presence_unknown')
    expect(physicalSpawn).not.toHaveBeenCalled()
  })

  it('refuses a runtime ensure of a session live in a desktop pane', async () => {
    const livePane = 'tab-live:33333333-3333-4333-8333-333333333333'
    gateDeps.listHookRows = () =>
      [
        {
          paneKey: livePane,
          worktreeId: surface.worktreeId,
          agentType: claim.agent,
          providerSession: SESSION
        }
      ] as never
    gateDeps.getBoundPtyIdForPaneKey = (paneKey: string) =>
      paneKey === livePane ? 'pty-desktop-live' : undefined
    gateDeps.probePtyLiveness = async () => true
    const physicalSpawn = claimProvider(async () => ({ id: PTY_ID, incarnationId: 'inc-e' }))
    const controller = registerAgentClaimController()

    await expect(controller.spawn(ensureRequest)).rejects.toThrow('agent_session_live_elsewhere')
    expect(physicalSpawn).not.toHaveBeenCalled()
  })

  describe('a host-side create that resumes a recorded session', () => {
    const legacyResume = {
      cols: 80,
      rows: 24,
      cwd: '/tmp/recovered-worktree',
      worktreeId: surface.worktreeId,
      tabId: surface.tabId,
      leafId: surface.leafId,
      launchAgent: 'claude',
      resumeProviderSession: SESSION
    }

    it('is refused while a desktop resume holds the session', async () => {
      expect(reservations.tryAcquire(KEY, 'op-vault', DESKTOP_WINDOW)).toBe('granted')
      const physicalSpawn = claimProvider(async () => ({ id: PTY_ID, incarnationId: 'inc-f' }))
      const controller = registerAgentClaimController()

      await expect(controller.spawn(legacyResume)).rejects.toThrow('agent_session_materializing')
      expect(physicalSpawn).not.toHaveBeenCalled()
    })

    it('holds a free session for its tab, and gives it back when the spawn fails', async () => {
      const physicalSpawn = claimProvider(async () => ({ id: PTY_ID, incarnationId: 'inc-g' }))
      const controller = registerAgentClaimController()

      await controller.spawn(legacyResume)
      expect(physicalSpawn).toHaveBeenCalledOnce()
      expect(reservations.holder(KEY)).toMatchObject({ ownerId: -1, tabId: surface.tabId })

      reservations.releaseForTab(surface.tabId)
      claimProvider(async () => {
        throw new Error('spawn failed')
      })
      await expect(
        registerAgentClaimController().spawn({ ...legacyResume, tabId: 'tab-other' })
      ).rejects.toThrow('spawn failed')
      expect(reservations.holder(KEY)).toBeNull()
    })

    it('does not consult the gate for a create that resumes nothing', async () => {
      expect(reservations.tryAcquire(KEY, 'op-vault', DESKTOP_WINDOW)).toBe('granted')
      const physicalSpawn = claimProvider(async () => ({ id: PTY_ID, incarnationId: 'inc-h' }))
      const controller = registerAgentClaimController()

      await controller.spawn({ ...legacyResume, resumeProviderSession: undefined })
      expect(physicalSpawn).toHaveBeenCalledOnce()
    })
  })

  it('refuses a desktop resume while a runtime ensure of the session is starting', async () => {
    let finishSpawn!: () => void
    const spawnStarted = new Promise<void>((started) => {
      claimProvider(
        () =>
          new Promise((resolve) => {
            started()
            finishSpawn = () => resolve({ id: PTY_ID, incarnationId: 'inc-b' })
          })
      )
    })
    const controller = registerAgentClaimController()
    const ensured = controller.spawn(ensureRequest)
    await spawnStarted

    const desktop = await desktopResume('tab-desktop')

    finishSpawn()
    await ensured
    expect(desktop).toEqual({ outcome: 'refused', reason: 'materializing' })
  })
})
