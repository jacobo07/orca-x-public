import { beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type * as NodeCrypto from 'node:crypto'
import { SshRelaySession } from './ssh-relay-session'
import { createMockDeps, mockDeploySuccess } from './ssh-relay-session-test-fixtures'

type MockMuxInstance = {
  requestHandlers: Map<string, (params: Record<string, unknown>) => Promise<unknown>>
}

const { acceptOutputExitMock, muxRequestMock, openConsumerSessionMock, muxInstancesRaw } =
  vi.hoisted(() => ({
    acceptOutputExitMock: vi.fn().mockResolvedValue(undefined),
    muxRequestMock: vi.fn(),
    openConsumerSessionMock: vi.fn(
      async (
        _mux: unknown,
        options: { clientInstanceId: string; outputFlowControl?: unknown }
      ) => ({
        clientInstanceId: options.clientInstanceId,
        clientGeneration: 1,
        ownerGeneration: 1,
        ownerLease: 'test-owner-lease'
      })
    ),
    muxInstancesRaw: [] as unknown[]
  }))
const muxInstances = muxInstancesRaw as MockMuxInstance[]

vi.mock('./ssh-relay-deploy', () => ({ deployAndLaunchRelay: vi.fn() }))
vi.mock('./ssh-pty-consumer-session', () => ({
  openSshPtyConsumerSession: openConsumerSessionMock
}))
vi.mock('../ipc/ssh-pty-output-intake-registry', () => ({
  acceptSshPtyOutputData: vi.fn().mockResolvedValue(undefined),
  acceptSshPtyOutputExit: acceptOutputExitMock,
  allocateSshPtyProviderGeneration: vi.fn(() => 17),
  beginSshPtyOutputGenerationMigration: vi.fn(() => ({
    byPty: new Map(),
    completion: Promise.resolve()
  })),
  closeSshPtyOutputGeneration: vi.fn(),
  getSshPtyAcceptedSourceCheckpoints: vi.fn(() => []),
  applySshPtySourceRecoveryCancellationProof: vi.fn(() => true),
  installSshPtySourceAckPublisher: vi.fn(() => () => {}),
  installSshPtySourceCancellationPublisher: vi.fn(() => () => {})
}))
vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand: vi.fn().mockResolvedValue('') }))
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeCrypto>()
  return { ...actual, randomUUID: vi.fn() }
})
vi.mock('./ssh-remote-orca-cli', () => ({
  runRemoteOrcaCli: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
}))
vi.mock('./ssh-channel-multiplexer', () => ({
  SshChannelMultiplexer: class MockSshChannelMultiplexer {
    requestHandlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>()
    notify = vi.fn()
    notifyWithSettlement = vi.fn()
    request = muxRequestMock
    onNotification = vi.fn().mockReturnValue(() => {})
    onNotificationByMethod = vi.fn().mockReturnValue(() => {})
    onRequest = vi.fn(
      (method: string, handler: (params: Record<string, unknown>) => Promise<unknown>) => {
        this.requestHandlers.set(method, handler)
        return () => this.requestHandlers.delete(method)
      }
    )
    onDispose = vi.fn().mockReturnValue(() => {})
    dispose = vi.fn()
    isDisposed = vi.fn().mockReturnValue(false)

    constructor() {
      muxInstancesRaw.push(this)
    }
  }
}))
vi.mock('../agent-hooks/remote-managed-hook-installers', () => ({
  installRemoteManagedAgentHooks: vi.fn()
}))
vi.mock('../providers/ssh-pty-provider', () => ({
  isSshPtyNotFoundError: (error: unknown) => String(error).includes('not found'),
  isSshPtyIdentityMismatchError: (error: unknown) => String(error).includes('identity mismatch'),
  SshPtyProvider: class MockSshPtyProvider {
    onData = vi.fn().mockReturnValue(() => {})
    onReplay = vi.fn().mockReturnValue(() => {})
    onExit = vi.fn().mockReturnValue(() => {})
    attach = vi.fn().mockResolvedValue(undefined)
    attachForReconnect = vi.fn().mockResolvedValue({})
    dispose = vi.fn()
  }
}))
vi.mock('../providers/ssh-filesystem-provider', () => ({
  SshFilesystemProvider: class MockSshFilesystemProvider {
    dispose = vi.fn()
  }
}))
vi.mock('../providers/ssh-git-provider', () => ({
  SshGitProvider: class MockSshGitProvider {}
}))
vi.mock('../ipc/pty', () => ({
  registerSshPtyProvider: vi.fn(),
  unregisterSshPtyProvider: vi.fn(),
  getSshPtyProvider: vi.fn(),
  getPtyIdsForConnection: vi.fn().mockReturnValue([]),
  clearPtyOwnershipForConnection: vi.fn(),
  clearProviderPtyState: vi.fn(),
  deletePtyOwnership: vi.fn(),
  setPtyOwnership: vi.fn(),
  restorePtyIncarnation: vi.fn(),
  isCurrentPtyExit: vi.fn(() => true),
  answerStartupTerminalColorQueriesForPty: vi.fn((_id: string, data: string) => data)
}))
vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  registerSshFilesystemProvider: vi.fn(),
  unregisterSshFilesystemProvider: vi.fn(),
  getSshFilesystemProvider: vi.fn().mockReturnValue({ dispose: vi.fn() })
}))
vi.mock('../providers/ssh-git-dispatch', () => ({
  registerSshGitProvider: vi.fn(),
  unregisterSshGitProvider: vi.fn()
}))

const {
  getSshPtyProvider,
  getPtyIdsForConnection,
  setPtyOwnership
} = await import('../ipc/pty')
const { deployAndLaunchRelay } = await import('./ssh-relay-deploy')


function wire(ptys: Record<string, string[]>, attach: Record<string, ReturnType<typeof vi.fn>>) {
  vi.mocked(getSshPtyProvider).mockImplementation(
    (id: string) =>
      ({ attachForReconnect: attach[id], dispose: vi.fn() }) as unknown as ReturnType<
        typeof getSshPtyProvider
      >
  )
  vi.mocked(getPtyIdsForConnection).mockImplementation((id: string) => ptys[id] ?? [])
}

describe('SshRelaySession host loss does not leak across hosts (row 73)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    muxInstances.splice(0)
    muxRequestMock.mockReset()
    muxRequestMock.mockResolvedValue([])
    vi.mocked(randomUUID).mockReset()
    vi.mocked(randomUUID).mockReturnValue('00000000-0000-4000-8000-000000000001')
    mockDeploySuccess()
  })

  it('drops host A, keeps host B untouched, and reattaches A without spawning anything', async () => {
    const a = createMockDeps()
    const b = createMockDeps()
    const sessionA = new SshRelaySession('host-a', a.getMainWindow, a.mockStore, a.mockPortForward)
    const sessionB = new SshRelaySession('host-b', b.getMainWindow, b.mockStore, b.mockPortForward)
    await sessionA.establish(a.mockConn)
    await sessionB.establish(b.mockConn)
    const muxB = muxInstances[1] as unknown as { dispose: ReturnType<typeof vi.fn> }
    const attach = { 'host-a': vi.fn().mockResolvedValue({}), 'host-b': vi.fn().mockResolvedValue({}) }
    wire({ 'host-a': ['pty-a1', 'pty-a2'], 'host-b': ['pty-b1'] }, attach)
    muxRequestMock.mockClear()
    vi.mocked(setPtyOwnership).mockClear()

    // Host A drops: its relay cannot be deployed, so it stays reconnecting.
    vi.mocked(deployAndLaunchRelay).mockRejectedValueOnce(new Error('connect ETIMEDOUT'))
    const lost = vi.fn()
    sessionA.setOnRelayLost(lost)
    await sessionA.reconnect(a.mockConn)

    expect(sessionA.getState()).toBe('reconnecting')
    expect(lost).toHaveBeenCalledWith('host-a')
    expect(sessionB.getState()).toBe('ready')
    expect(muxB.dispose).not.toHaveBeenCalled()
    expect(attach['host-b']).not.toHaveBeenCalled()
    expect(b.mockStore.markSshRemotePtyLease).not.toHaveBeenCalled()
    expect(attach['host-a']).not.toHaveBeenCalled()

    // Host A returns: each known PTY is reattached exactly once; nothing is spawned.
    mockDeploySuccess()
    muxRequestMock.mockClear()
    await sessionA.reconnect(a.mockConn)

    expect(sessionA.getState()).toBe('ready')
    expect(attach['host-a'].mock.calls.map((c) => c[0]).sort()).toEqual(['pty-a1', 'pty-a2'])
    expect(attach['host-b']).not.toHaveBeenCalled()
    const methods = muxRequestMock.mock.calls.map((c) => String(c[0]))
    expect(methods.filter((m) => /spawn|launch|create|job|agent\.start/i.test(m))).toEqual([])
    const owned = vi.mocked(setPtyOwnership).mock.calls.map((c) => String(c[0]))
    expect(new Set(owned).size).toBe(owned.length)
    expect(sessionB.getState()).toBe('ready')
    expect(muxB.dispose).not.toHaveBeenCalled()
  })
})
