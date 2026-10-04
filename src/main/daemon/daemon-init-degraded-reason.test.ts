import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FAKE_RUNTIME_DIR } from './daemon-init-test-harness'

const {
  probeSocketExistsMock,
  netConnectMock,
  forkMock,
  checkDaemonHealthMock,
  killStaleDaemonMock,
  daemonClientMock,
  spawnerInstances,
  importFresh,
  installDefaultNetConnectStub,
  mockConnectedAdoptionClientOnce,
  moduleFactories
} = await vi.hoisted(async () =>
  (await import('./daemon-init-test-harness')).createDaemonInitMocks()
)

vi.mock('electron', () => moduleFactories.electron())
vi.mock('fs', () => moduleFactories.fs())
vi.mock('child_process', async (importOriginal) =>
  moduleFactories.childProcess(await importOriginal<Record<string, unknown>>())
)
vi.mock('net', () => moduleFactories.net())
vi.mock('./daemon-health', () => moduleFactories.daemonHealth())
vi.mock('./daemon-pid-identity', () => moduleFactories.daemonPidIdentity())
vi.mock('./daemon-tcc-attribution', () => moduleFactories.daemonTccAttribution())
vi.mock('./daemon-bundle-staleness', () => moduleFactories.daemonBundleStaleness())
vi.mock('./daemon-stale-kill', () => moduleFactories.daemonStaleKill())
vi.mock('./daemon-process-start-time', () => moduleFactories.daemonProcessStartTime())
vi.mock('./daemon-pid-file-parse', () => moduleFactories.daemonPidFileParse())
vi.mock('./client', () => moduleFactories.client())
vi.mock('./daemon-lifecycle-event', () => moduleFactories.daemonLifecycleEvent())
vi.mock('./daemon-spawner', () => moduleFactories.daemonSpawner())
vi.mock('./daemon-pty-adapter', () => moduleFactories.daemonPtyAdapter())
vi.mock('../ipc/pty', () => moduleFactories.ipcPty())

type DegradedHandle = {
  mode?: string
  degradedReason?: string
  releaseAdoptionLease?(): void
}
type Launcher = (
  socketPath: string,
  tokenPath: string,
  pidPath?: string,
  launchNonce?: string
) => Promise<DegradedHandle>

async function startLauncher(): Promise<Launcher> {
  const mod = await importFresh()
  checkDaemonHealthMock.mockResolvedValue('unreachable')
  await mod.initDaemonPtyProvider()
  return spawnerInstances[0].launcher as Launcher
}

function degradedLines(warn: ReturnType<typeof vi.spyOn>): string[] {
  return warn.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.includes('DEGRADED MODE'))
}

// A socket that accepts the connect and never says anything: what probeSocket reads as alive.
function acceptConnects(): void {
  probeSocketExistsMock.mockReturnValue(true)
  netConnectMock.mockImplementation(() => {
    const handlers: Record<string, (() => void)[]> = { connect: [], error: [] }
    return {
      on(event: string, cb: () => void) {
        handlers[event]?.push(cb)
        if (event === 'connect') {
          queueMicrotask(() => cb())
        }
        return this
      },
      removeListener(event: string, cb: () => void) {
        handlers[event] = handlers[event]?.filter((handler) => handler !== cb) ?? []
        return this
      },
      destroy() {}
    }
  })
}

function unreachableClient(): { ensureConnected: () => Promise<void> } & Record<string, unknown> {
  return {
    ensureConnected: vi.fn(async () => {
      throw new Error('endpoint accepted the connect and gave no hello')
    }),
    getDaemonIdentity: vi.fn(() => null),
    request: vi.fn(async () => ({ sessions: [] })),
    disconnect: vi.fn()
  }
}

function answeringClient(): Record<string, unknown> {
  return {
    ensureConnected: vi.fn(async () => {}),
    getDaemonIdentity: vi.fn(() => null),
    request: vi.fn(async () => ({ sessions: [] })),
    disconnect: vi.fn()
  }
}

describe('daemon-init: a degraded adoption states the guard that forced it (R-08)', () => {
  beforeEach(() => {
    installDefaultNetConnectStub()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  // Why: a degrade that names no reason is indistinguishable from a healthy adoption.
  it.each(['identity_unverifiable', 'unconfirmed_exit'] as const)(
    'names preservedBy=%s from the kill outcome in the line and the preserved state',
    async (preservedBy) => {
      const launcher = await startLauncher()
      // Why a variable: the harness types the mock's result without preservedBy.
      const outcome = { killed: false, liveOwnerSurvived: true, preservedBy }
      killStaleDaemonMock.mockResolvedValueOnce(outcome)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const handle = await launcher('/fake/socket', '/fake/token', '/fake/daemon.pid', 'nonce')

        const lines = degradedLines(warn)
        expect(lines).toHaveLength(1)
        expect(lines[0]).toContain(`reason=${preservedBy}`)
        expect(handle.mode).toBe('degraded-new-pty-fallback')
        expect(handle.degradedReason).toBe(preservedBy)
        handle.releaseAdoptionLease?.()
      } finally {
        warn.mockRestore()
      }
    }
  )

  it('says reason=unknown for an outcome that carries no preservedBy, never omits it', async () => {
    const launcher = await startLauncher()
    killStaleDaemonMock.mockResolvedValueOnce({ killed: false, liveOwnerSurvived: true })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const handle = await launcher('/fake/socket', '/fake/token', '/fake/daemon.pid', 'nonce')

      const lines = degradedLines(warn)
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('reason=unknown')
      expect(handle.degradedReason).toBe('unknown')
      handle.releaseAdoptionLease?.()
    } finally {
      warn.mockRestore()
    }
  })

  it('names live_sessions when the spawn-health-check site preserves a daemon that owns sessions', async () => {
    const launcher = await startLauncher()
    const requestMock = vi.fn(async (method: string) =>
      method === 'listSessions' ? { sessions: [{ sessionId: 'wt-1@@live', isAlive: true }] } : {}
    )
    mockConnectedAdoptionClientOnce()
    daemonClientMock.mockImplementationOnce(function MockDaemonClient() {
      return { ensureConnected: vi.fn(async () => {}), request: requestMock, disconnect: vi.fn() }
    })
    checkDaemonHealthMock.mockResolvedValueOnce('pty-spawn-unhealthy')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const handle = await launcher('/fake/socket', '/fake/token')

      const lines = degradedLines(warn)
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('reason=live_sessions')
      expect(lines[0]).toContain('liveSessions=1')
      expect(handle.degradedReason).toBe('live_sessions')
    } finally {
      warn.mockRestore()
    }
  })

  it('names publish_failed when a replacement could not publish and an endpoint answers', async () => {
    const launcher = await startLauncher()
    killStaleDaemonMock.mockResolvedValueOnce({ killed: true, liveOwnerSurvived: false })
    forkMock.mockImplementationOnce(() => {
      throw new Error('replacement could not publish')
    })
    // The endpoint accepts a connect only after the failed launch.
    acceptConnects()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const handle = await launcher('/fake/socket', '/fake/token', '/fake/daemon.pid', 'nonce')

      const lines = degradedLines(warn)
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('reason=publish_failed')
      expect(handle.degradedReason).toBe('publish_failed')
      handle.releaseAdoptionLease?.()
    } finally {
      warn.mockRestore()
    }
  })
  // R-09: the kill outcome for an endpoint that accepted a connect after a confirmed exit and gave
  // no protocol answer. Both readers of liveOwnerSurvived must stay fail-closed on it.
  const UNVERIFIED = {
    killed: true,
    liveOwnerSurvived: true,
    preservedBy: 'endpoint_unverified'
  }

  it('startup: an unverified endpoint is adopted in DEGRADED MODE naming it, and nothing forks beside it', async () => {
    const launcher = await startLauncher()
    killStaleDaemonMock.mockResolvedValueOnce(UNVERIFIED)
    const forksBefore = forkMock.mock.calls.length
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const handle = await launcher('/fake/socket', '/fake/token', '/fake/daemon.pid', 'nonce')

      expect(degradedLines(warn)[0]).toContain('reason=endpoint_unverified')
      expect(handle.mode).toBe('degraded-new-pty-fallback')
      expect(handle.degradedReason).toBe('endpoint_unverified')
      expect(forkMock.mock.calls.length).toBe(forksBefore)
      handle.releaseAdoptionLease?.()
    } finally {
      warn.mockRestore()
    }
  })

  it('startup: when the unverified endpoint cannot be adopted either, the launch aborts without forking', async () => {
    const launcher = await startLauncher()
    killStaleDaemonMock.mockResolvedValueOnce(UNVERIFIED)
    // Launcher clients in order: the adoption probe, the session count, then the adoption lease.
    daemonClientMock
      .mockImplementationOnce(answeringClient)
      .mockImplementationOnce(answeringClient)
      .mockImplementationOnce(unreachableClient)
    const forksBefore = forkMock.mock.calls.length
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(
        launcher('/fake/socket', '/fake/token', '/fake/daemon.pid', 'nonce')
      ).rejects.toThrow('Daemon replacement aborted')

      expect(forkMock.mock.calls.length).toBe(forksBefore)
    } finally {
      warn.mockRestore()
    }
  })

  it('cleanup: an unverified endpoint refuses the restart instead of reporting it cleaned', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()
    acceptConnects()
    daemonClientMock.mockImplementationOnce(unreachableClient)
    killStaleDaemonMock.mockResolvedValueOnce(UNVERIFIED)

    await expect(mod.cleanupDaemonForProtocol(FAKE_RUNTIME_DIR, 1)).rejects.toThrow(
      'Daemon cleanup aborted'
    )
  })
})
