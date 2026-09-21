import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import {
  FAKE_USER_DATA_PATH,
  FAKE_RUNTIME_DIR,
  FAKE_DAEMON_ENTRY_PATH
} from './daemon-init-test-harness'

const {
  isPackagedMock,
  readFileSyncMock,
  forkMock,
  checkDaemonHealthMock,
  getMacDaemonTccAttributionHealthMock,
  getDaemonLaunchIdentityMock,
  killStaleDaemonMock,
  replaceDaemonPidFileMock,
  daemonClientMock,
  spawnerInstances,
  trackDaemonReplacedMock,
  importFresh,
  installDefaultNetConnectStub,
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

describe('daemon-init: runRestartDaemon (7-step sequence)', () => {
  beforeEach(() => {
    installDefaultNetConnectStub()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('respawns instead of reusing a healthy daemon launched from another app path', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider(undefined, {
      macosLoginSessionWatch: true
    })

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    getDaemonLaunchIdentityMock.mockReturnValueOnce('mismatch')
    forkMock.mockImplementationOnce(() => {
      const handlers: Record<string, ((arg?: unknown) => void)[]> = {
        message: [],
        error: [],
        exit: []
      }
      return {
        pid: 12345,
        on(event: string, cb: (arg?: unknown) => void) {
          handlers[event]?.push(cb)
          if (event === 'message') {
            queueMicrotask(() => cb({ type: 'ready', startedAtMs: 1_000_000 }))
          }
          return this
        },
        off(event: string, cb: (arg?: unknown) => void) {
          handlers[event] = handlers[event]?.filter((handler) => handler !== cb) ?? []
          return this
        },
        disconnect: vi.fn(),
        unref: vi.fn()
      }
    })

    await launcher('/fake/socket', '/fake/token')

    expect(getDaemonLaunchIdentityMock).toHaveBeenCalledWith(
      FAKE_RUNTIME_DIR,
      '/fake/socket',
      '/fake/token',
      FAKE_DAEMON_ENTRY_PATH
    )
    expect(killStaleDaemonMock).toHaveBeenCalledWith(
      FAKE_RUNTIME_DIR,
      '/fake/socket',
      '/fake/token',
      undefined,
      { preserveLiveWork: true }
    )
    expect(forkMock).toHaveBeenCalledWith(
      FAKE_DAEMON_ENTRY_PATH,
      expect.arrayContaining([
        '--socket',
        '/fake/socket',
        '--token',
        '/fake/token',
        '--login-session-watch',
        '--log-file',
        join(FAKE_USER_DATA_PATH, 'logs', 'daemon.log')
      ]),
      expect.objectContaining({ cwd: '/fake/userData', detached: true })
    )
    // STA-2376: different-app-path replacement, emitted exactly once.
    expect(trackDaemonReplacedMock).toHaveBeenCalledTimes(1)
    expect(trackDaemonReplacedMock).toHaveBeenCalledWith('different_app_path', 0)
  })

  it('adopts the winner when a launched daemon loses the endpoint race', async () => {
    // Why: losing the publish race is an expected outcome, not a crash. Reporting it as a
    // startup failure strands this app on local non-persistent PTYs beside a healthy daemon.
    const mod = await importFresh()
    await mod.initDaemonPtyProvider(undefined, { macosLoginSessionWatch: true })

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    // Force the replace-and-launch path; otherwise the launcher adopts the healthy daemon and
    // never forks, and this test would pass without exercising anything.
    getDaemonLaunchIdentityMock.mockReturnValueOnce('mismatch')
    forkMock.mockImplementationOnce(() => {
      const handlers: Record<string, ((arg?: unknown) => void)[]> = {
        message: [],
        error: [],
        exit: []
      }
      return {
        pid: 24680,
        on(event: string, cb: (arg?: unknown) => void) {
          handlers[event]?.push(cb)
          // Why the exit code and not the message: the launcher settles on exit, so keying
          // adoption off the notification alone could lose that race.
          if (event === 'exit') {
            queueMicrotask(() => cb(20))
          }
          return this
        },
        off(event: string, cb: (arg?: unknown) => void) {
          handlers[event] = handlers[event]?.filter((handler) => handler !== cb) ?? []
          return this
        },
        kill: vi.fn(),
        disconnect: vi.fn(),
        unref: vi.fn()
      }
    })

    // A handle rather than a rejection means the incumbent was adopted.
    await expect(launcher('/fake/socket', '/fake/token')).resolves.toMatchObject({
      shutdown: expect.any(Function)
    })
    // Guard against passing for the wrong reason: the adoption must follow a real launch.
    expect(forkMock).toHaveBeenCalledTimes(1)
  })

  it('replaces a healthy daemon whose macOS TCC attribution is severed when it has no live sessions', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider(undefined, { macosLoginSessionWatch: true })

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    getMacDaemonTccAttributionHealthMock.mockResolvedValueOnce('severed')
    forkMock.mockImplementationOnce(() => {
      const handlers: Record<string, ((arg?: unknown) => void)[]> = {
        message: [],
        error: [],
        exit: []
      }
      return {
        pid: 12345,
        on(event: string, cb: (arg?: unknown) => void) {
          handlers[event]?.push(cb)
          if (event === 'message') {
            queueMicrotask(() => cb({ type: 'ready', startedAtMs: 1_000_000 }))
          }
          return this
        },
        off(event: string, cb: (arg?: unknown) => void) {
          handlers[event] = handlers[event]?.filter((handler) => handler !== cb) ?? []
          return this
        },
        disconnect: vi.fn(),
        unref: vi.fn()
      }
    })

    await launcher('/fake/socket', '/fake/token')

    expect(forkMock).toHaveBeenCalledTimes(1)
    // STA-3491: attribution-severed replacement is billed to its own reason, exactly once.
    expect(trackDaemonReplacedMock).toHaveBeenCalledTimes(1)
    expect(trackDaemonReplacedMock).toHaveBeenCalledWith('severed_tcc_attribution', 0)
  })

  it('preserves a severed-attribution daemon that owns live sessions', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider(undefined, { macosLoginSessionWatch: true })

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    getMacDaemonTccAttributionHealthMock.mockResolvedValueOnce('severed')
    // Why: live sessions must veto replacement — the Settings surface owns the remedy instead.
    daemonClientMock.mockImplementation(function MockDaemonClient() {
      return {
        ensureConnected: vi.fn(async () => {}),
        request: vi.fn(async () => ({ sessions: [{ sessionId: 's1', isAlive: true }] })),
        disconnect: vi.fn()
      }
    })

    const handle = await launcher('/fake/socket', '/fake/token')

    expect(handle).toBeDefined()
    expect(forkMock).not.toHaveBeenCalled()
    expect(killStaleDaemonMock).not.toHaveBeenCalled()
    expect(trackDaemonReplacedMock).not.toHaveBeenCalled()
  })

  it('holds a full adoption pair before a healthy launcher resolves', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()
    const events: string[] = []
    const disconnect = vi.fn()
    daemonClientMock.mockImplementationOnce(function MockAdoptionClient() {
      return {
        ensureConnected: vi.fn(async () => {
          events.push('full-pair')
        }),
        request: vi.fn(),
        disconnect
      }
    })
    checkDaemonHealthMock.mockImplementationOnce(async () => {
      events.push('health')
      return 'healthy'
    })
    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{
      releaseAdoptionLease?(): void
      shutdown(): Promise<void>
    }>

    const handle = await launcher('/fake/socket', '/fake/token')

    expect(events[0]).toBe('full-pair')
    expect(events.indexOf('full-pair')).toBeLessThan(events.indexOf('health'))
    expect(disconnect).not.toHaveBeenCalled()
    handle.releaseAdoptionLease?.()
    expect(disconnect).toHaveBeenCalledOnce()
  })

  it('repairs a stale PID record to the authenticated socket owner before adoption', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()
    const endpointIdentity = {
      pid: 101,
      startedAtMs: 1_000_000,
      launchNonce: 'socket-owner'
    }
    daemonClientMock.mockImplementationOnce(function MockAdoptionClient() {
      return {
        ensureConnected: vi.fn(async () => {}),
        getDaemonIdentity: vi.fn(() => endpointIdentity),
        request: vi.fn(),
        disconnect: vi.fn()
      }
    })
    readFileSyncMock.mockReturnValueOnce(
      JSON.stringify({
        pid: 202,
        startedAtMs: 2_000_000,
        launchNonce: 'stale-owner'
      })
    )
    readFileSyncMock.mockReturnValueOnce(JSON.stringify(endpointIdentity))
    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string,
      pidPath?: string,
      launchNonce?: string
    ) => Promise<{ releaseAdoptionLease?(): void; shutdown(): Promise<void> }>
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const handle = await launcher(
        '/fake/socket',
        '/fake/token',
        '/fake/daemon.pid',
        'unused-new-launch'
      )

      expect(replaceDaemonPidFileMock).toHaveBeenCalledWith('/fake/daemon.pid', endpointIdentity)
      expect(warn).toHaveBeenCalledWith(
        '[daemon] Repaired daemon PID ownership to match the authenticated endpoint'
      )
      handle.releaseAdoptionLease?.()
    } finally {
      warn.mockRestore()
    }
  })

  /**
   * Two authorities describe the daemon incarnation: the authenticated hello, and the durable pid
   * record. They can disagree, and the disagreement is EVIDENCE -- of a stale record, a recycled
   * pid, a second daemon, or a leaked token. It is not the same event as having no record at all.
   *
   * Both took the same branch and printed the same line, so an operator reading the log could not
   * tell "these two authorities contradicted each other" from "there was nothing to compare".
   * Only one of those is worth investigating.
   *
   * This is classification, not authority: the repair behaviour is deliberately unchanged, and the
   * hello gains nothing it did not already have. See the trust-boundary note in the reconciler.
   */
  it('names a contradicting PID record as a contradiction, not as an absent one', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()
    const endpointIdentity = { pid: 101, startedAtMs: 1_000_000, launchNonce: 'socket-owner' }
    daemonClientMock.mockImplementationOnce(function MockAdoptionClient() {
      return {
        ensureConnected: vi.fn(async () => {}),
        getDaemonIdentity: vi.fn(() => endpointIdentity),
        request: vi.fn(),
        disconnect: vi.fn()
      }
    })
    readFileSyncMock.mockReturnValueOnce(
      JSON.stringify({ pid: 202, startedAtMs: 2_000_000, launchNonce: 'stale-owner' })
    )
    readFileSyncMock.mockReturnValueOnce(JSON.stringify(endpointIdentity))
    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string,
      pidPath?: string,
      launchNonce?: string
    ) => Promise<{ releaseAdoptionLease?(): void; shutdown(): Promise<void> }>
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const handle = await launcher('/fake/socket', '/fake/token', '/fake/daemon.pid', 'unused')
      const lines = warn.mock.calls.map((call) => String(call[0]))

      expect(
        lines.some((line) => line.includes('contradicts the authenticated endpoint')),
        'a record naming a different incarnation was not reported as a contradiction'
      ).toBe(true)
      // The nonce is an incarnation identifier, not something to spray into a log the user may
      // paste into an issue. Naming the disagreeing FIELDS is what an operator needs.
      expect(lines.some((line) => line.includes('stale-owner'))).toBe(false)
      expect(replaceDaemonPidFileMock).toHaveBeenCalledWith('/fake/daemon.pid', endpointIdentity)
      handle.releaseAdoptionLease?.()
    } finally {
      warn.mockRestore()
    }
  })

  it('does not call an unreadable PID record a contradiction', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()
    const endpointIdentity = { pid: 101, startedAtMs: 1_000_000, launchNonce: 'socket-owner' }
    daemonClientMock.mockImplementationOnce(function MockAdoptionClient() {
      return {
        ensureConnected: vi.fn(async () => {}),
        getDaemonIdentity: vi.fn(() => endpointIdentity),
        request: vi.fn(),
        disconnect: vi.fn()
      }
    })
    // Nothing to compare against: this is an absent authority, not a conflicting one.
    readFileSyncMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
    })
    readFileSyncMock.mockReturnValueOnce(JSON.stringify(endpointIdentity))
    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string,
      pidPath?: string,
      launchNonce?: string
    ) => Promise<{ releaseAdoptionLease?(): void; shutdown(): Promise<void> }>
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const handle = await launcher('/fake/socket', '/fake/token', '/fake/daemon.pid', 'unused')
      const lines = warn.mock.calls.map((call) => String(call[0]))

      expect(
        lines.some((line) => line.includes('contradicts the authenticated endpoint')),
        'an absent record was reported as two authorities disagreeing'
      ).toBe(false)
      expect(
        lines.some((line) => line.includes('could not be read')),
        'an absent record was not reported at all'
      ).toBe(true)
      // Behaviour is unchanged: the record is still published for the authenticated owner.
      expect(replaceDaemonPidFileMock).toHaveBeenCalledWith('/fake/daemon.pid', endpointIdentity)
      handle.releaseAdoptionLease?.()
    } finally {
      warn.mockRestore()
    }
  })

  it('stays silent and repairs nothing when the two authorities agree', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()
    const endpointIdentity = { pid: 101, startedAtMs: 1_000_000, launchNonce: 'socket-owner' }
    daemonClientMock.mockImplementationOnce(function MockAdoptionClient() {
      return {
        ensureConnected: vi.fn(async () => {}),
        getDaemonIdentity: vi.fn(() => endpointIdentity),
        request: vi.fn(),
        disconnect: vi.fn()
      }
    })
    // Not mockReturnValueOnce: the agreement claim must not depend on which read in the flow
    // happens to consume the queue. Every read returns the agreeing record.
    readFileSyncMock.mockReturnValue(JSON.stringify(endpointIdentity))
    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string,
      pidPath?: string,
      launchNonce?: string
    ) => Promise<{ releaseAdoptionLease?(): void; shutdown(): Promise<void> }>
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // initDaemonPtyProvider() publishes a record of its own before any reconciliation happens, so
    // an absolute "never called" assertion fails on a precondition rather than on the claim. The
    // claim is about what the RECONCILER did, so bracket the launcher call and measure the delta.
    const republishedBeforeAdoption = replaceDaemonPidFileMock.mock.calls.length

    try {
      const handle = await launcher('/fake/socket', '/fake/token', '/fake/daemon.pid', 'unused')
      const lines = warn.mock.calls.map((call) => String(call[0]))

      // The healthy path must not acquire conflict handling it has no use for.
      expect(lines.some((line) => line.includes('contradicts the authenticated endpoint'))).toBe(
        false
      )
      expect(lines.some((line) => line.includes('could not be read'))).toBe(false)
      expect(
        replaceDaemonPidFileMock.mock.calls.length - republishedBeforeAdoption,
        'agreeing authorities still rewrote the record'
      ).toBe(0)
      handle.releaseAdoptionLease?.()
    } finally {
      warn.mockRestore()
      readFileSyncMock.mockReset()
    }
  })

  it('republishes the endpoint owner launch metadata into a repaired PID record', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()
    // Why: the mismatched record's metadata belongs to another daemon, so freshness and
    // host-pinning fields must come from the authenticated owner — a record without
    // appVersion reads as a permanently stale bundle and gets needlessly replaced. The
    // install path deliberately contains a space: re-parsing it out of a space-joined
    // command line truncated it and made a healthy daemon look like a different app path.
    const endpointIdentity = {
      pid: 101,
      startedAtMs: 1_000_000,
      launchNonce: 'socket-owner',
      entryPath: '/Applications/Orca 2.app/Contents/out/main/daemon-entry.js',
      appVersion: '9.9.9',
      spawnerExecPath: '/Applications/Orca 2.app/Contents/MacOS/Orca'
    }
    daemonClientMock.mockImplementationOnce(function MockAdoptionClient() {
      return {
        ensureConnected: vi.fn(async () => {}),
        getDaemonIdentity: vi.fn(() => endpointIdentity),
        request: vi.fn(),
        disconnect: vi.fn()
      }
    })
    readFileSyncMock.mockReturnValueOnce(
      JSON.stringify({
        pid: 202,
        startedAtMs: 2_000_000,
        launchNonce: 'stale-owner'
      })
    )
    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string,
      pidPath?: string,
      launchNonce?: string
    ) => Promise<{ releaseAdoptionLease?(): void; shutdown(): Promise<void> }>
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const handle = await launcher('/fake/socket', '/fake/token', '/fake/daemon.pid', 'unused')

      expect(replaceDaemonPidFileMock).toHaveBeenCalledWith('/fake/daemon.pid', {
        pid: 101,
        startedAtMs: 1_000_000,
        launchNonce: 'socket-owner',
        entryPath: '/Applications/Orca 2.app/Contents/out/main/daemon-entry.js',
        appVersion: '9.9.9',
        spawnerExecPath: '/Applications/Orca 2.app/Contents/MacOS/Orca'
      })
      handle.releaseAdoptionLease?.()
    } finally {
      warn.mockRestore()
    }
  })

  it('adopts the authenticated endpoint even when the PID record cannot be repaired', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()
    const endpointIdentity = {
      pid: 101,
      startedAtMs: 1_000_000,
      launchNonce: 'socket-owner'
    }
    daemonClientMock.mockImplementationOnce(function MockAdoptionClient() {
      return {
        ensureConnected: vi.fn(async () => {}),
        getDaemonIdentity: vi.fn(() => endpointIdentity),
        request: vi.fn(),
        disconnect: vi.fn()
      }
    })
    readFileSyncMock.mockReturnValueOnce(
      JSON.stringify({
        pid: 202,
        startedAtMs: 2_000_000,
        launchNonce: 'stale-owner'
      })
    )
    // Why: fail open. Losing every persistent terminal because a pid file write failed is a
    // far worse outcome than a record that disagrees with the endpoint.
    replaceDaemonPidFileMock.mockReturnValueOnce(false)
    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string,
      pidPath?: string,
      launchNonce?: string
    ) => Promise<{ releaseAdoptionLease?(): void; shutdown(): Promise<void> }>
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const forkCallsBefore = forkMock.mock.calls.length

    try {
      const handle = await launcher('/fake/socket', '/fake/token', '/fake/daemon.pid', 'unused')

      expect(handle).toBeDefined()
      // The healthy daemon is adopted, not replaced.
      expect(forkMock.mock.calls.length).toBe(forkCallsBefore)
      expect(warn).toHaveBeenCalledWith(
        '[daemon] Could not repair daemon PID ownership; adopting the authenticated endpoint anyway'
      )
      handle.releaseAdoptionLease?.()
    } finally {
      warn.mockRestore()
    }
  })

  it('degrades instead of forking beside a daemon that could not be confirmed stopped', async () => {
    const mod = await importFresh()
    checkDaemonHealthMock.mockResolvedValue('unreachable')
    await mod.initDaemonPtyProvider()
    const forkCallsBefore = forkMock.mock.calls.length
    // Why: forking beside a survivor is exactly how the endpoint owner and the session host
    // diverge — one daemon answers the socket while another hosts the visible terminals. But
    // refusing outright would leave the user with no daemon at all, and something demonstrably
    // still answers the endpoint, so adopt it degraded: live sessions keep working.
    killStaleDaemonMock.mockResolvedValueOnce({
      killed: false,
      liveOwnerSurvived: true
    })
    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string,
      pidPath?: string,
      launchNonce?: string
    ) => Promise<{ mode?: string; releaseAdoptionLease?(): void }>
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const handle = await launcher('/fake/socket', '/fake/token', '/fake/daemon.pid', 'launch-new')

      expect(handle.mode).toBe('degraded-new-pty-fallback')
      expect(forkMock.mock.calls.length).toBe(forkCallsBefore)
      handle.releaseAdoptionLease?.()
    } finally {
      warn.mockRestore()
    }
  })

  it('disconnects every temporary client when healthy adoption fails', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()
    const initialDisconnect = vi.fn()
    const replacementDisconnect = vi.fn()
    daemonClientMock
      .mockImplementationOnce(function MockInitialAdoptionClient() {
        return {
          ensureConnected: vi.fn(async () => {
            throw new Error('initial adoption failed')
          }),
          request: vi.fn(),
          disconnect: initialDisconnect
        }
      })
      .mockImplementationOnce(function MockReplacementAdoptionClient() {
        return {
          ensureConnected: vi.fn(async () => {
            throw new Error('replacement adoption failed')
          }),
          request: vi.fn(),
          disconnect: replacementDisconnect
        }
      })
    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>

    await expect(launcher('/fake/socket', '/fake/token')).rejects.toThrow(
      'replacement adoption failed'
    )

    expect(initialDisconnect).toHaveBeenCalledOnce()
    expect(replacementDisconnect).toHaveBeenCalledOnce()
    expect(forkMock).not.toHaveBeenCalled()
  })

  it('adopts a healthy daemon whose pid-file identity cannot be verified (null startedAtMs metadata)', async () => {
    // Why: startedAtMs null (all pre-fix Windows pid files) → identity 'unknown'; a live daemon must ADOPT, not replace.
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    getDaemonLaunchIdentityMock.mockReturnValueOnce('unknown')
    isPackagedMock.mockReturnValue(true)

    await launcher('/fake/socket', '/fake/token')

    expect(killStaleDaemonMock).not.toHaveBeenCalled()
    expect(forkMock).not.toHaveBeenCalled()
  })
})
