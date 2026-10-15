import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type * as NodeCrypto from 'node:crypto'
import { SshRelaySession } from './ssh-relay-session'
import { toAppSshPtyId } from '../providers/ssh-pty-id'
import { createMockDeps, mockDeploySuccess } from './ssh-relay-session-test-fixtures'

type MockMuxInstance = {
  requestHandlers: Map<string, (params: Record<string, unknown>) => Promise<unknown>>
  notify: ReturnType<typeof vi.fn>
  notifyWithSettlement: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
}

const { muxRequestMock, openConsumerSessionMock, muxInstancesRaw } = vi.hoisted(() => ({
  muxRequestMock: vi.fn(),
  openConsumerSessionMock: vi.fn(
    async (_mux: unknown, options: { clientInstanceId: string; outputFlowControl?: unknown }) => ({
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
  acceptSshPtyOutputExit: vi.fn().mockResolvedValue(undefined),
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

const { getSshPtyProvider, getPtyIdsForConnection, setPtyOwnership } = await import('../ipc/pty')
const { deployAndLaunchRelay } = await import('./ssh-relay-deploy')

// Measured: every relay method the return of a host issued (requests and notifications) in this harness.
const RETURN_ALLOW_LIST: ReadonlySet<string> = new Set<string>([
  'session.resolveHome',
  'agent_hook.installPlugins',
  'agent_hook.requestReplay',
  'preflight.detectAgents',
  'ports.detect',
  'relay.configureGraceTime'
])

// The deny-regex the single host-loss test uses; kept only to prove it is blind to a renamed spawn.
const OLD_DENY_REGEX = /spawn|launch|create|job|agent\.start/i

function unexpectedMethods(issued: readonly string[], allow: ReadonlySet<string>): string[] {
  return Array.from(new Set(issued.filter((method) => !allow.has(method)))).sort()
}

// Orchestration dispatch lives in src/main/runtime/orchestration; a session that imports it could re-dispatch.
function importsOrchestrationTree(source: string): string[] {
  const specifiers = Array.from(source.matchAll(/from\s+'([^']+)'/g), (match) => match[1] ?? '')
  return specifiers.filter((specifier) => /runtime\/orchestration/.test(specifier))
}

// Any create/attach-fresh call on a provider lands here; a return must leave it at zero calls.
const createdOnHost: Record<string, ReturnType<typeof vi.fn>> = {
  'host-a': vi.fn(),
  'host-b': vi.fn()
}

function wire(ptys: Record<string, string[]>, attach: Record<string, ReturnType<typeof vi.fn>>) {
  vi.mocked(getSshPtyProvider).mockImplementation(
    (id: string) =>
      ({
        attachForReconnect: attach[id],
        attach: createdOnHost[id],
        spawn: createdOnHost[id],
        dispose: vi.fn()
      }) as unknown as ReturnType<typeof getSshPtyProvider>
  )
  vi.mocked(getPtyIdsForConnection).mockImplementation((id: string) => ptys[id] ?? [])
}

const KNOWN_A = ['pty-a1', 'pty-a2']
const KNOWN_A_APP_IDS = KNOWN_A.map((id) => toAppSshPtyId('host-a', id))

async function hostLossThenReturn() {
  const a = createMockDeps()
  const b = createMockDeps()
  const sessionA = new SshRelaySession('host-a', a.getMainWindow, a.mockStore, a.mockPortForward)
  const sessionB = new SshRelaySession('host-b', b.getMainWindow, b.mockStore, b.mockPortForward)
  await sessionA.establish(a.mockConn)
  await sessionB.establish(b.mockConn)
  const muxB = muxInstances[1]
  const attach = {
    'host-a': vi.fn().mockResolvedValue({}),
    'host-b': vi.fn().mockResolvedValue({})
  }
  wire({ 'host-a': [...KNOWN_A], 'host-b': ['pty-b1'] }, attach)

  vi.mocked(deployAndLaunchRelay).mockRejectedValueOnce(new Error('connect ETIMEDOUT'))
  await sessionA.reconnect(a.mockConn)
  expect(sessionA.getState()).toBe('reconnecting')
  expect(attach['host-a']).not.toHaveBeenCalled()

  // Only what the return itself issues is recorded.
  mockDeploySuccess()
  muxRequestMock.mockClear()
  vi.mocked(setPtyOwnership).mockClear()
  const instancesBeforeReturn = muxInstances.length
  await sessionA.reconnect(a.mockConn)
  const returnMux = muxInstances[instancesBeforeReturn]
  return { a, b, sessionA, sessionB, muxB, returnMux, attach }
}

function issuedMethods(mux: MockMuxInstance): string[] {
  return [
    ...muxRequestMock.mock.calls.map((call) => String(call[0])),
    ...mux.notify.mock.calls.map((call) => String(call[0])),
    ...mux.notifyWithSettlement.mock.calls.map((call) => String(call[0]))
  ]
}

describe('SshRelaySession host return does not duplicate anything (row 73)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    muxInstances.splice(0)
    muxRequestMock.mockReset()
    muxRequestMock.mockResolvedValue([])
    vi.mocked(randomUUID).mockReset()
    vi.mocked(randomUUID).mockReturnValue('00000000-0000-4000-8000-000000000001')
    mockDeploySuccess()
  })

  it('issues only allow-listed relay methods when host A returns', async () => {
    // Arrange
    const { returnMux } = await hostLossThenReturn()

    // Act
    const issued = issuedMethods(returnMux)

    // Assert
    expect(issued.length).toBeGreaterThan(0)
    expect(unexpectedMethods(issued, RETURN_ALLOW_LIST)).toEqual([])
  })

  it('CONTROL: the same checker names a spawn and a method the old regex cannot see', async () => {
    // Arrange
    const { returnMux } = await hostLossThenReturn()
    const issued = [...issuedMethods(returnMux), 'pty.spawn', 'pty.begin']

    // Act
    const unexpected = unexpectedMethods(issued, RETURN_ALLOW_LIST)
    const oldRegexHits = issued.filter((method) => OLD_DENY_REGEX.test(method))

    // Assert
    expect(unexpected).toEqual(['pty.begin', 'pty.spawn'])
    expect(oldRegexHits).toEqual(['pty.spawn'])
    expect(OLD_DENY_REGEX.test('pty.begin')).toBe(false)
  })

  it('reattaches each known PTY exactly once, creates none and leaves host B untouched', async () => {
    // Arrange
    const { sessionA, sessionB, muxB, b, attach } = await hostLossThenReturn()

    // Act
    const attachedIds = attach['host-a'].mock.calls.map((call) => String(call[0])).sort()
    const owned = vi.mocked(setPtyOwnership).mock.calls.map((call) => String(call[0]))

    // Assert
    expect(sessionA.getState()).toBe('ready')
    expect(attachedIds).toEqual(KNOWN_A)
    expect(createdOnHost['host-a']).not.toHaveBeenCalled()
    expect(createdOnHost['host-b']).not.toHaveBeenCalled()
    expect(owned.length).toBeGreaterThan(0)
    expect(new Set(owned).size).toBe(owned.length)
    expect(owned.filter((id) => !KNOWN_A_APP_IDS.includes(id))).toEqual([])
    expect(attach['host-b']).not.toHaveBeenCalled()
    expect(b.mockStore.markSshRemotePtyLease).not.toHaveBeenCalled()
    expect(muxB.dispose).not.toHaveBeenCalled()
    expect(sessionB.getState()).toBe('ready')
  })

  it('a second return attaches the same known set once more, never a different or doubled one', async () => {
    // Arrange
    const { a, sessionA, attach } = await hostLossThenReturn()
    expect(attach['host-a']).toHaveBeenCalledTimes(KNOWN_A.length)
    attach['host-a'].mockClear()
    vi.mocked(setPtyOwnership).mockClear()

    // Act
    mockDeploySuccess()
    await sessionA.reconnect(a.mockConn)

    // Assert
    expect(attach['host-a'].mock.calls.map((call) => String(call[0])).sort()).toEqual(KNOWN_A)
    const owned = vi.mocked(setPtyOwnership).mock.calls.map((call) => String(call[0]))
    expect(new Set(owned).size).toBe(owned.length)
    expect(owned.filter((id) => !KNOWN_A_APP_IDS.includes(id))).toEqual([])
  })

  it('two overlapping returns (a fast flap) attach each known PTY once in total', async () => {
    // Arrange
    const { a, sessionA, attach } = await hostLossThenReturn()
    attach['host-a'].mockClear()
    vi.mocked(setPtyOwnership).mockClear()
    mockDeploySuccess()

    // Act: the second call aborts the first before it reaches the reattach step.
    await Promise.all([sessionA.reconnect(a.mockConn), sessionA.reconnect(a.mockConn)])

    // Assert
    expect(attach['host-a'].mock.calls.map((call) => String(call[0])).sort()).toEqual(KNOWN_A)
    const owned = vi.mocked(setPtyOwnership).mock.calls.map((call) => String(call[0]))
    expect(new Set(owned).size).toBe(owned.length)
    expect(sessionA.getState()).toBe('ready')
  })

  it('the session cannot re-dispatch orchestration work because it does not import that tree', () => {
    // Arrange
    const source = readFileSync(join(__dirname, 'ssh-relay-session.ts'), 'utf8')

    // Act
    const imported = importsOrchestrationTree(source)

    // Assert
    expect(source).toContain("from './ssh-relay-deploy'")
    expect(imported).toEqual([])
  })

  it('CONTROL: the import check flags a module that does import the orchestration tree', () => {
    // Arrange
    const source = "import { x } from '../runtime/orchestration/db'\nimport { y } from './other'"

    // Act
    const imported = importsOrchestrationTree(source)

    // Assert
    expect(imported).toEqual(['../runtime/orchestration/db'])
  })
})
