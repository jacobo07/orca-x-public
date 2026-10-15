import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockDispatcher, type RelayDispatcher } from '../../../../relay/git-handler-test-setup'
import { GitReplicaHandler } from '../../../../relay/git-replica-handler'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { ReplicaPairCompareResult, ReplicaPairRelationsResult } from '../../../../shared/replica-pair-view'
import { createReplicaPairService } from '../../../replica-pair-service'
import { installReplicaPairService } from '../../../replica-pair-service-slot'
import { resetSshRelayCapabilityCacheForTests } from '../../../ssh/ssh-relay-capabilities'
import type { RpcContext } from '../core'
import { PROJECT_REPLICA_METHODS } from './project-replica'

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t'
}
const git = (cwd: string, ...a: string[]): string =>
  execFileSync('git', a, { cwd, env: ENV, encoding: 'utf8' }).trim()

// The slot type carries the capsule operations too; the compare and relations tests never reach them.
const capsuleStubs = () => ({ capsuleCreate: vi.fn(), capsuleList: vi.fn(), capsuleRestore: vi.fn() })

const compare = PROJECT_REPLICA_METHODS.find((m) => m.name === 'projectReplica.compare')!
const call = (params: unknown, ctx: Partial<RpcContext> = {}) =>
  compare.handler(params, { runtime: {} as RpcContext['runtime'], ...ctx }) as Promise<ReplicaPairCompareResult>

let root: string
let local: string
let remote: string
let d: ReturnType<typeof createMockDispatcher>
let h: GitReplicaHandler
const savedTmp = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP }

const setup = (
  over: Partial<ProjectHostSetup> & Pick<ProjectHostSetup, 'id' | 'hostId' | 'path'>
): ProjectHostSetup => ({
  projectId: 'p1',
  repoId: `repo-${over.id}`,
  displayName: over.id,
  setupState: 'ready',
  setupMethod: 'imported-existing-folder',
  createdAt: 1,
  updatedAt: 1,
  ...over
})

function installReal(capabilities: string[]): void {
  installReplicaPairService(
    createReplicaPairService({
      listProjectHostSetups: () => [
        setup({ id: 'anchor', hostId: 'local', path: local }),
        setup({ id: 'box', hostId: 'ssh:gex44', connectionId: 'gex44', path: remote, createdAt: 2 })
      ],
      sshSession: {
        getMultiplexer: () => ({
          isDisposed: () => false,
          request: async (method, params) =>
            method === 'relay.status' ? { capabilities } : d.callRequest(method, params ?? {})
        }),
        getGeneration: () => 1
      }
    })
  )
}

beforeEach(() => {
  resetSshRelayCapabilityCacheForTests()
  root = mkdtempSync(join(tmpdir(), 'prr-'))
  // Why: compare stages bundles under os.tmpdir(); a private one keeps parallel suites that list the shared one honest.
  mkdirSync(join(root, 'scratch'))
  process.env.TMPDIR = process.env.TMP = process.env.TEMP = join(root, 'scratch')
  local = join(root, 'local')
  remote = join(root, 'remote')
  git(root, 'init', '-q', '-b', 'main', local)
  git(local, 'commit', '--allow-empty', '-qm', 'base')
  git(root, 'clone', '-q', local, remote)
  d = createMockDispatcher()
  h = new GitReplicaHandler(d as unknown as RelayDispatcher)
})
afterEach(async () => {
  for (const [key, value] of Object.entries(savedTmp)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  installReplicaPairService(null)
  await h.dispose()
  rmSync(root, { recursive: true, force: true })
})

describe('projectReplica.compare', () => {
  it('a local caller gets the fenced pairs from the real service over the real relay handler', async () => {
    git(remote, 'commit', '--allow-empty', '-qm', 'r1')
    installReal(['git.replicaBundle'])
    const result = await call({ projectId: 'p1' })
    expect(result).toMatchObject({
      status: 'ok',
      pairs: [{ setupId: 'box', relation: { kind: 'behind', count: 1 }, healthy: false }]
    })
  })

  it('refuses every remote caller before the service is called; control: a local caller is served', async () => {
    const service = {
      compare: vi.fn(async () => ({ status: 'ok' as const, pairs: [] })),
      relations: vi.fn(async () => ({ status: 'ok' as const, pairs: [] })),
      ...capsuleStubs()
    }
    installReplicaPairService(service)
    const remoteCallers: Partial<RpcContext>[] = [
      { clientKind: 'mobile' },
      { clientKind: 'runtime' },
      { pairedDeviceId: 'dev-1' },
      { clientId: 'token' },
      { connectionId: 'socket-1' },
      { authenticatedCallerFingerprint: 'fp' }
    ]
    for (const ctx of remoteCallers) {
      await expect(call({ projectId: 'p1' }, ctx)).resolves.toEqual({ status: 'refused', reason: 'remote-caller' })
    }
    expect(service.compare).not.toHaveBeenCalled()
    await expect(call({ projectId: 'p1' })).resolves.toEqual({ status: 'ok', pairs: [] })
    expect(service.compare).toHaveBeenCalledTimes(1)
  })

  it('says unavailable when no service is installed rather than answering with no pairs', async () => {
    await expect(call({ projectId: 'p1' })).resolves.toEqual({ status: 'unavailable', reason: 'no-replica-service' })
    // Control: the same call with an installed slot is served.
    installReal(['git.replicaBundle'])
    expect((await call({ projectId: 'p1' })).status).toBe('ok')
  })

  it('validates params strictly: projectId is required and unknown keys are rejected', () => {
    const schema = compare.params!
    expect(schema.safeParse({ projectId: 'p1' }).success).toBe(true)
    expect(schema.safeParse({ projectId: 'p1', setupId: 's1' }).success).toBe(true)
    expect(schema.safeParse({}).success).toBe(false)
    expect(schema.safeParse({ projectId: 'p1', extra: 1 }).success).toBe(false)
  })
})

describe('projectReplica.relations', () => {
  const relations = PROJECT_REPLICA_METHODS.find((m) => m.name === 'projectReplica.relations')!
  const callRelations = (ctx: Partial<RpcContext> = {}) =>
    relations.handler(undefined, { runtime: {} as RpcContext['runtime'], ...ctx }) as Promise<ReplicaPairRelationsResult>
  const fake = () => ({
    compare: vi.fn(async () => ({ status: 'ok' as const, pairs: [] })),
    relations: vi.fn(async () => ({ status: 'ok' as const, pairs: [] })),
    ...capsuleStubs()
  })

  it('a local caller gets the views', async () => {
    const service = fake()
    installReplicaPairService(service)
    await expect(callRelations()).resolves.toEqual({ status: 'ok', pairs: [] })
    expect(service.relations).toHaveBeenCalledTimes(1)
  })

  it('refuses a remote caller with the service never called; unavailable when the slot is empty', async () => {
    const service = fake()
    installReplicaPairService(service)
    await expect(callRelations({ pairedDeviceId: 'dev-1' })).resolves.toEqual({ status: 'refused', reason: 'remote-caller' })
    expect(service.relations).not.toHaveBeenCalled()
    installReplicaPairService(null)
    await expect(callRelations()).resolves.toEqual({ status: 'unavailable', reason: 'no-replica-service' })
  })

  it('takes no params', () => {
    expect(relations.params).toBeNull()
  })
})

describe('every projectReplica method is local-caller only', () => {
  it('refuses each remote caller shape before any service call; control: a local caller is not refused', async () => {
    const service = {
      compare: vi.fn(async () => ({ status: 'ok' as const, pairs: [] })),
      relations: vi.fn(async () => ({ status: 'ok' as const, pairs: [] })),
      ...capsuleStubs()
    }
    installReplicaPairService(service)
    const remoteCallers: Partial<RpcContext>[] = [
      { clientKind: 'mobile' },
      { pairedDeviceId: 'dev-1' },
      { clientId: 'token' },
      { connectionId: 'socket-1' },
      { authenticatedCallerFingerprint: 'fp' }
    ]
    expect(PROJECT_REPLICA_METHODS.length).toBeGreaterThanOrEqual(2)
    for (const method of PROJECT_REPLICA_METHODS) {
      for (const ctx of remoteCallers) {
        const res = await method.handler({ projectId: 'p1' }, { runtime: {} as RpcContext['runtime'], ...ctx })
        expect(res, `${method.name} ${JSON.stringify(ctx)}`).toEqual({ status: 'refused', reason: 'remote-caller' })
      }
      const local = (await method.handler({ projectId: 'p1' }, { runtime: {} as RpcContext['runtime'] })) as { status: string }
      expect(local.status, method.name).not.toBe('refused')
    }
    expect(service.compare).toHaveBeenCalledTimes(1)
    expect(service.relations).toHaveBeenCalledTimes(1)
  })
})
