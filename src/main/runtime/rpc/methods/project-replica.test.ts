import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockDispatcher, type RelayDispatcher } from '../../../../relay/git-handler-test-setup'
import { GitReplicaHandler } from '../../../../relay/git-replica-handler'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type {
  ReplicaCapsuleCreateResult,
  ReplicaCapsuleListResult,
  ReplicaCapsuleRestoreResult
} from '../../../../shared/replica-capsule-view'
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

const ALL_NAMES = [
  'projectReplica.compare',
  'projectReplica.relations',
  'projectReplica.capsuleCreate',
  'projectReplica.capsuleList',
  'projectReplica.capsuleRestore'
]

const capsule = (name: string) => PROJECT_REPLICA_METHODS.find((m) => m.name === name)!
const callMethod = (name: string, params: unknown, ctx: Partial<RpcContext> = {}) =>
  capsule(name).handler(params, { runtime: {} as RpcContext['runtime'], ...ctx })

function fakeService() {
  return {
    compare: vi.fn(async () => ({ status: 'ok' as const, pairs: [] })),
    relations: vi.fn(async () => ({ status: 'ok' as const, pairs: [] })),
    capsuleCreate: vi.fn(async () => ({ status: 'ok' as const, outcome: { kind: 'clean' as const } })),
    capsuleList: vi.fn(async () => ({ status: 'ok' as const, capsules: [] })),
    capsuleRestore: vi.fn(async () => ({ status: 'refused' as const, reason: 'worktree-not-clean' as const }))
  }
}

const REMOTE_CALLERS: Partial<RpcContext>[] = [
  { clientKind: 'mobile' },
  { pairedDeviceId: 'dev-1' },
  { clientId: 'token' },
  { connectionId: 'socket-1' },
  { authenticatedCallerFingerprint: 'fp' }
]
const PARAMS_OF: Record<string, unknown> = {
  'projectReplica.compare': { projectId: 'p1' },
  'projectReplica.relations': undefined,
  'projectReplica.capsuleCreate': { setupId: 's1' },
  'projectReplica.capsuleList': { setupId: 's1' },
  'projectReplica.capsuleRestore': { setupId: 's1', capsule: 'f'.repeat(40) }
}

describe('every projectReplica method is local-caller only', () => {
  it('registers exactly the five methods this surface owns', () => {
    expect(PROJECT_REPLICA_METHODS.map((m) => m.name)).toEqual(ALL_NAMES)
  })

  it('refuses each remote caller shape before any service call; control: a local caller is not refused', async () => {
    const service = fakeService()
    installReplicaPairService(service)
    for (const method of PROJECT_REPLICA_METHODS) {
      for (const ctx of REMOTE_CALLERS) {
        const res = await callMethod(method.name, PARAMS_OF[method.name], ctx)
        expect(res, `${method.name} ${JSON.stringify(ctx)}`).toEqual({ status: 'refused', reason: 'remote-caller' })
      }
      const local = (await callMethod(method.name, PARAMS_OF[method.name])) as { reason?: string }
      expect(local.reason, method.name).not.toBe('remote-caller')
    }
    for (const fn of Object.values(service)) {
      expect(fn).toHaveBeenCalledTimes(1)
    }
  })

  it('answers unavailable for each capsule method when the slot is empty', async () => {
    for (const name of ALL_NAMES.filter((n) => n.includes('capsule'))) {
      await expect(callMethod(name, PARAMS_OF[name])).resolves.toEqual({
        status: 'unavailable',
        reason: 'no-replica-service'
      })
    }
  })
})

describe('projectReplica capsule params', () => {
  const ok = (name: string, params: unknown): boolean => capsule(name).params!.safeParse(params).success

  it('capsuleCreate and capsuleList take only a setupId', () => {
    for (const name of ['projectReplica.capsuleCreate', 'projectReplica.capsuleList']) {
      expect(ok(name, { setupId: 's1' }), name).toBe(true)
      expect(ok(name, {}), name).toBe(false)
      expect(ok(name, { setupId: '' }), name).toBe(false)
      expect(ok(name, { setupId: 1 }), name).toBe(false)
      expect(ok(name, { setupId: 's1', path: '/tmp' }), name).toBe(false)
    }
  })

  it('capsuleRestore takes setupId, capsule and a strictly boolean apply', () => {
    const name = 'projectReplica.capsuleRestore'
    const base = { setupId: 's1', capsule: 'f'.repeat(40) }
    expect(ok(name, base)).toBe(true)
    expect(ok(name, { ...base, apply: true })).toBe(true)
    expect(ok(name, { ...base, apply: false })).toBe(true)
    expect(ok(name, { ...base, apply: 'true' })).toBe(false)
    expect(ok(name, { ...base, apply: 1 })).toBe(false)
    expect(ok(name, { setupId: 's1' })).toBe(false)
    expect(ok(name, { ...base, extra: 1 })).toBe(false)
  })
})

describe('projectReplica capsule methods reach the service', () => {
  it('capsuleCreate and capsuleList pass the setup id through and return the closed union unchanged', async () => {
    const service = fakeService()
    installReplicaPairService(service)
    const created = (await callMethod('projectReplica.capsuleCreate', { setupId: 's1' })) as ReplicaCapsuleCreateResult
    expect(created).toEqual({ status: 'ok', outcome: { kind: 'clean' } })
    expect(service.capsuleCreate).toHaveBeenCalledWith({ setupId: 's1' })
    const listed = (await callMethod('projectReplica.capsuleList', { setupId: 's1' })) as ReplicaCapsuleListResult
    expect(listed).toEqual({ status: 'ok', capsules: [] })
    expect(service.capsuleList).toHaveBeenCalledWith({ setupId: 's1' })
  })

  it('capsuleRestore passes apply only for the boolean true; absent, false and look-alikes are plan', async () => {
    const service = fakeService()
    installReplicaPairService(service)
    const capsuleRef = 'f'.repeat(40)
    const modeOf = async (extra: object): Promise<unknown> => {
      service.capsuleRestore.mockClear()
      const res = (await callMethod('projectReplica.capsuleRestore', {
        setupId: 's1',
        capsule: capsuleRef,
        ...extra
      })) as ReplicaCapsuleRestoreResult
      expect(res.status).toBe('refused')
      return (service.capsuleRestore.mock.calls[0] as unknown[])[0]
    }
    expect(await modeOf({ apply: true })).toEqual({ setupId: 's1', capsule: capsuleRef, mode: 'apply' })
    expect(await modeOf({})).toEqual({ setupId: 's1', capsule: capsuleRef, mode: 'plan' })
    expect(await modeOf({ apply: false })).toEqual({ setupId: 's1', capsule: capsuleRef, mode: 'plan' })
    // The handler does not lean on the schema alone: a truthy non-boolean that bypassed it is still plan.
    expect(await modeOf({ apply: 'yes' })).toEqual({ setupId: 's1', capsule: capsuleRef, mode: 'plan' })
    expect(await modeOf({ apply: 1 })).toEqual({ setupId: 's1', capsule: capsuleRef, mode: 'plan' })
  })

  it('a local caller reaches the real service and createCapsule over a temp repo', async () => {
    installReplicaPairService(
      createReplicaPairService({ listProjectHostSetups: () => [setup({ id: 'anchor', hostId: 'local', path: local })] })
    )
    expect(await callMethod('projectReplica.capsuleCreate', { setupId: 'anchor' })).toEqual({
      status: 'ok',
      outcome: { kind: 'clean' }
    })
    writeFileSync(join(local, 'dirty.txt'), 'dirty\n')
    const res = (await callMethod('projectReplica.capsuleCreate', { setupId: 'anchor' })) as ReplicaCapsuleCreateResult
    expect(res).toMatchObject({ status: 'ok', outcome: { kind: 'created', alreadyExisted: false } })
    const ref = (res as { outcome: { ref: string } }).outcome.ref
    expect(git(local, 'rev-parse', '--verify', ref)).toMatch(/^[0-9a-f]{40}$/)
    expect(await callMethod('projectReplica.capsuleList', { setupId: 'anchor' })).toMatchObject({
      status: 'ok',
      capsules: [{ ref }]
    })
    // The remote caller changes nothing: its refusal leaves the repo as it was.
    const before = git(local, 'for-each-ref', 'refs/orca/capsules')
    writeFileSync(join(local, 'other.txt'), 'other\n')
    await callMethod('projectReplica.capsuleCreate', { setupId: 'anchor' }, { clientKind: 'mobile' })
    expect(git(local, 'for-each-ref', 'refs/orca/capsules')).toBe(before)
    expect(existsSync(join(local, 'other.txt'))).toBe(true)
  })
})
