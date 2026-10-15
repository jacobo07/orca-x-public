import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMockDispatcher, type RelayDispatcher } from '../relay/git-handler-test-setup'
import { GitReplicaHandler } from '../relay/git-replica-handler'
import { ReplicaFactsHandler } from '../relay/replica-facts-handler'
import type { ProjectHostSetup } from '../shared/project-types'
import { publishedRelationsOf } from '../shared/replica-pair-view'
import { readLocalReplicaFacts } from './replica-local-facts'
import { createReplicaPairService, replicaHostKey } from './replica-pair-service'
import { resetSshRelayCapabilityCacheForTests } from './ssh/ssh-relay-capabilities'

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t'
}
const git = (cwd: string, ...a: string[]): string =>
  execFileSync('git', a, { cwd, env: ENV, encoding: 'utf8' }).trim()
const commit = (cwd: string, msg: string): void => {
  git(cwd, 'commit', '--allow-empty', '-qm', msg)
}

let root: string
let local: string
let remote: string
let d: ReturnType<typeof createMockDispatcher>
let h: GitReplicaHandler
let calls: string[]
let log: string[]
let scratch: string
const savedTmp = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP }

const setup = (over: Partial<ProjectHostSetup> & Pick<ProjectHostSetup, 'id' | 'hostId' | 'path'>): ProjectHostSetup => ({
  projectId: 'p1',
  repoId: `repo-${over.id}`,
  displayName: over.id,
  setupState: 'ready',
  setupMethod: 'imported-existing-folder',
  createdAt: 1,
  updatedAt: 1,
  ...over
})

type SessionHooks = {
  live?: (connectionId: string) => boolean
  beforeRequest?: (connectionId: string, method: string) => Promise<void> | void
}

function sshSession(capabilities: string[], hooks: SessionHooks = {}) {
  return {
    getMultiplexer: (connectionId: string) =>
      hooks.live && !hooks.live(connectionId)
        ? undefined
        : {
            isDisposed: () => false,
            request: async (method: string, params?: Record<string, unknown>) => {
              calls.push(method)
              log.push(`${connectionId}:${method}`)
              await hooks.beforeRequest?.(connectionId, method)
              if (method === 'relay.status') {
                return { capabilities }
              }
              return d.callRequest(method, params ?? {})
            }
          },
    getGeneration: () => 1
  }
}

function service(
  capabilities: string[],
  setups: ProjectHostSetup[],
  hooks?: SessionHooks,
  readLocalFacts?: typeof readLocalReplicaFacts
) {
  return createReplicaPairService({
    ...(readLocalFacts ? { readLocalFacts } : {}),
    listProjectHostSetups: () => setups,
    sshSession: sshSession(capabilities, hooks),
    now: () => 7
  })
}

const localSetup = () => setup({ id: 'anchor', hostId: 'local', path: local, createdAt: 1 })
const sshSetup = () => setup({ id: 'box', hostId: 'ssh:gex44', connectionId: 'gex44', path: remote, createdAt: 2 })

beforeEach(() => {
  resetSshRelayCapabilityCacheForTests()
  calls = []
  log = []
  root = mkdtempSync(join(tmpdir(), 'rps-'))
  // Why: compare stages bundles under os.tmpdir(); a private one keeps parallel suites that list the shared one honest.
  scratch = join(root, 'scratch')
  mkdirSync(scratch)
  process.env.TMPDIR = process.env.TMP = process.env.TEMP = scratch
  local = join(root, 'local')
  remote = join(root, 'remote')
  git(root, 'init', '-q', '-b', 'main', local)
  commit(local, 'base')
  git(root, 'clone', '-q', local, remote)
  d = createMockDispatcher()
  h = new GitReplicaHandler(d as unknown as RelayDispatcher)
  void new ReplicaFactsHandler(d as unknown as RelayDispatcher)
})
afterEach(async () => {
  for (const [key, value] of Object.entries(savedTmp)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  await h.dispose()
  rmSync(root, { recursive: true, force: true })
})

async function pairOf(svc: ReturnType<typeof service>) {
  const res = await svc.compare({ projectId: 'p1' })
  expect(res.status).toBe('ok')
  if (res.status !== 'ok') {
    throw new Error('expected ok')
  }
  expect(res.pairs).toHaveLength(1)
  return res.pairs[0]
}

describe('createReplicaPairService.compare over the real relay handler', () => {
  it('the setup holding two more commits reads as the anchor behind by 2, with both observed tips', async () => {
    commit(remote, 'r1')
    commit(remote, 'r2')
    const pair = await pairOf(service(['git.replicaBundle'], [localSetup(), sshSetup()]))
    expect(pair).toMatchObject({
      setupId: 'box',
      anchorSetupId: 'anchor',
      hostId: 'ssh:gex44',
      relation: { kind: 'behind', count: 2 },
      healthy: false
    })
    expect(pair.relation).toMatchObject({ observedTips: [git(local, 'rev-parse', 'HEAD'), git(remote, 'rev-parse', 'HEAD')] })
    expect(pair.remoteTip).toBe(git(remote, 'rev-parse', 'HEAD'))
    expect(readdirSync(scratch).filter((n) => n.startsWith('orca-replica-recv-'))).toEqual([])
  })

  it('the setup behind the anchor reads as the anchor ahead', async () => {
    commit(local, 'l1')
    const pair = await pairOf(service(['git.replicaBundle'], [localSetup(), sshSetup()]))
    expect(pair.relation).toMatchObject({ kind: 'ahead', count: 1 })
    expect(pair.healthy).toBe(false)
  })

  it('both moved is diverged with the merge base', async () => {
    const base = git(local, 'rev-parse', 'HEAD')
    commit(local, 'l1')
    commit(remote, 'r1')
    const pair = await pairOf(service(['git.replicaBundle'], [localSetup(), sshSetup()]))
    expect(pair.relation).toMatchObject({ kind: 'diverged', mergeBase: base, aheadCount: 1, behindCount: 1 })
  })

  it('equal tips against a relay without sync.v1 are same but not healthy', async () => {
    const pair = await pairOf(service(['git.replicaBundle'], [localSetup(), sshSetup()]))
    expect(pair.relation.kind).toBe('same')
    expect(pair.healthy).toBe(false)
    expect(calls).not.toContain('sync.replicaFacts')
  })

  it('equal tips with both worktrees clean against a sync.v1 relay are healthy; control: a dirty remote is not', async () => {
    const pair = await pairOf(service(['git.replicaBundle', 'sync.v1'], [localSetup(), sshSetup()]))
    expect(pair.relation.kind).toBe('same')
    expect(pair.healthy).toBe(true)
    expect(calls).toContain('sync.replicaFacts')

    resetSshRelayCapabilityCacheForTests()
    writeFileSync(join(remote, 'wip.txt'), 'x')
    const dirty = await pairOf(service(['git.replicaBundle', 'sync.v1'], [localSetup(), sshSetup()]))
    expect(dirty.relation.kind).toBe('same')
    expect(dirty.healthy).toBe(false)
  })

  it('a relay without git.replicaBundle is unknown relay-too-old and nothing healthy; control: the capable relay compares', async () => {
    commit(remote, 'r1')
    const old = await pairOf(service(['git.exec'], [localSetup(), sshSetup()]))
    expect(old.relation).toEqual({ kind: 'unknown', reason: 'relay-too-old' })
    expect(old.healthy).toBe(false)
    expect(old.remoteTip).toBeUndefined()
    expect(calls).toEqual(['relay.status'])

    resetSshRelayCapabilityCacheForTests()
    const capable = await pairOf(service(['git.replicaBundle'], [localSetup(), sshSetup()]))
    expect(capable.relation.kind).toBe('behind')
  })

  it('keeps each host in its own ref namespace under the anchor', async () => {
    commit(remote, 'r1')
    await pairOf(service(['git.replicaBundle'], [localSetup(), sshSetup()]))
    expect(git(local, 'rev-parse', `refs/orca/replicas/${replicaHostKey('ssh:gex44')}/HEAD`)).toBe(
      git(remote, 'rev-parse', 'HEAD')
    )
  })

  it('a shallow anchor never decides ancestry: unknown shallow; control: the full anchor decides', async () => {
    commit(local, 'second')
    const shallow = join(root, 'shallow')
    git(root, 'clone', '-q', '--depth', '1', `file://${local}`, shallow)
    commit(remote, 'r1')
    const shallowAnchor = setup({ id: 'anchor', hostId: 'local', path: shallow, createdAt: 1 })
    const pair = await pairOf(service(['git.replicaBundle'], [shallowAnchor, sshSetup()]))
    expect(pair.relation).toEqual({ kind: 'unknown', reason: 'shallow' })
    resetSshRelayCapabilityCacheForTests()
    const full = await pairOf(service(['git.replicaBundle'], [localSetup(), sshSetup()]))
    expect(full.relation.kind).not.toBe('unknown')
  })

  it('answers not-found for an unknown project and for a setup outside the project', async () => {
    const svc = service(['git.replicaBundle'], [localSetup(), sshSetup()])
    await expect(svc.compare({ projectId: 'nope' })).resolves.toEqual({ status: 'not-found', reason: 'unknown-project' })
    await expect(svc.compare({ projectId: 'p1', setupId: 'nope' })).resolves.toEqual({
      status: 'not-found',
      reason: 'unknown-setup'
    })
    // Control: a setup of the project compares.
    const ok = await svc.compare({ projectId: 'p1', setupId: 'box' })
    expect(ok).toMatchObject({ status: 'ok', pairs: [{ setupId: 'box' }] })
  })
})

describe('replicaHostKey', () => {
  it('matches the ref-safe pattern', () => {
    expect(replicaHostKey('ssh:gex44')).toMatch(/^[A-Za-z0-9._-]+$/)
    expect(replicaHostKey('ssh:we%20ird host/../x')).toMatch(/^[A-Za-z0-9._-]+$/)
  })
})

describe('failure arms and single-flight', () => {
  const exportsOf = (connectionId: string) => log.filter((e) => e === `${connectionId}:git.replicaBundleExport`)
  const byId = (pairs: Awaited<ReturnType<ReturnType<typeof service>['compare']>>) => {
    expect(pairs.status).toBe('ok')
    return new Map(pairs.status === 'ok' ? pairs.pairs.map((p) => [p.setupId, p]) : [])
  }

  it('a host with no live multiplexer is host-unreachable with no relay request; control: the connected host compares', async () => {
    commit(remote, 'r1')
    const up = setup({ id: 'up', hostId: 'ssh:up', connectionId: 'up', path: remote, createdAt: 2 })
    const down = setup({ id: 'down', hostId: 'ssh:down', connectionId: 'down', path: remote, createdAt: 3 })
    const res = await service(['git.replicaBundle'], [localSetup(), up, down], { live: (id) => id === 'up' }).compare({
      projectId: 'p1'
    })
    const pairs = byId(res)
    expect(pairs.get('down')?.relation).toEqual({ kind: 'unknown', reason: 'host-unreachable' })
    expect(pairs.get('down')?.healthy).toBe(false)
    expect(log.filter((e) => e.startsWith('down:'))).toEqual([])
    expect(pairs.get('up')?.relation.kind).toBe('behind')
    expect(exportsOf('up')).toHaveLength(1)
  })

  it('a runtime-owned host is transport-unsupported-host and makes no relay request; control: ssh compares', async () => {
    const rt = setup({ id: 'rt', hostId: 'runtime:env1', path: remote, createdAt: 2 })
    const pairs = byId(await service(['git.replicaBundle'], [localSetup(), rt, sshSetup()]).compare({ projectId: 'p1' }))
    expect(pairs.get('rt')?.relation).toEqual({ kind: 'unknown', reason: 'transport-unsupported-host' })
    expect(pairs.get('box')?.relation.kind).toBe('same')
    expect(log.every((e) => e.startsWith('gex44:'))).toBe(true)
  })

  it('a project with no local setup is no-comparison-site for every setup; control: with an anchor it compares', async () => {
    const a = setup({ id: 'a', hostId: 'ssh:a', connectionId: 'a', path: remote, createdAt: 1 })
    const b = setup({ id: 'b', hostId: 'ssh:b', connectionId: 'b', path: remote, createdAt: 2 })
    const pairs = byId(await service(['git.replicaBundle'], [a, b]).compare({ projectId: 'p1' }))
    expect([...pairs.values()].map((p) => p.relation)).toEqual([
      { kind: 'unknown', reason: 'no-comparison-site' },
      { kind: 'unknown', reason: 'no-comparison-site' }
    ])
    expect(pairs.get('a')?.anchorSetupId).toBeNull()
    expect(log).toEqual([])
    const withAnchor = byId(await service(['git.replicaBundle'], [localSetup(), a, b]).compare({ projectId: 'p1' }))
    expect(withAnchor.get('a')?.relation.kind).toBe('same')
  })

  it('a folder setup on either side is not-a-git-repo with no relay request; control: git setups compare', async () => {
    const folderRemote = setup({ id: 'fr', hostId: 'ssh:gex44', connectionId: 'gex44', path: remote, kind: 'folder', createdAt: 2 })
    const remoteSide = byId(await service(['git.replicaBundle'], [localSetup(), folderRemote]).compare({ projectId: 'p1' }))
    expect(remoteSide.get('fr')?.relation).toEqual({ kind: 'unknown', reason: 'not-a-git-repo' })
    const folderAnchor = setup({ id: 'anchor', hostId: 'local', path: local, kind: 'folder', createdAt: 1 })
    const anchorSide = byId(await service(['git.replicaBundle'], [folderAnchor, sshSetup()]).compare({ projectId: 'p1' }))
    expect(anchorSide.get('box')?.relation).toEqual({ kind: 'unknown', reason: 'not-a-git-repo' })
    expect(log).toEqual([])
    const control = byId(await service(['git.replicaBundle'], [localSetup(), sshSetup()]).compare({ projectId: 'p1' }))
    expect(control.get('box')?.relation.kind).toBe('same')
  })

  it('an anchor path that is not a repository reads not-a-git-repo; an unborn anchor reads unborn', async () => {
    const plain = join(root, 'plain')
    git(root, 'init', '-q', '-b', 'main', plain)
    const unborn = byId(
      await service(['git.replicaBundle'], [setup({ id: 'anchor', hostId: 'local', path: plain }), sshSetup()]).compare({ projectId: 'p1' })
    )
    expect(unborn.get('box')?.relation).toEqual({ kind: 'unknown', reason: 'unborn' })
    rmSync(join(plain, '.git'), { recursive: true, force: true })
    const notRepo = byId(
      await service(['git.replicaBundle'], [setup({ id: 'anchor', hostId: 'local', path: plain }), sshSetup()]).compare({ projectId: 'p1' })
    )
    expect(notRepo.get('box')?.relation).toEqual({ kind: 'unknown', reason: 'not-a-git-repo' })
    expect(log).toEqual([])
  })

  it('two concurrent compares of one setup make one relay export; control: sequential compares each export', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const svc = service(['git.replicaBundle'], [localSetup(), sshSetup()], {
      beforeRequest: (_id, method) => (method === 'git.replicaBundleExport' ? gate : undefined)
    })
    const first = svc.compare({ projectId: 'p1' })
    const second = svc.compare({ projectId: 'p1' })
    // Let both reach the gated export before releasing it.
    await new Promise((resolve) => setTimeout(resolve, 100))
    release()
    const [a, b] = await Promise.all([first, second])
    expect(exportsOf('gex44')).toHaveLength(1)
    expect(a).toEqual(b)

    log = []
    resetSshRelayCapabilityCacheForTests()
    const seq = service(['git.replicaBundle'], [localSetup(), sshSetup()])
    await seq.compare({ projectId: 'p1' })
    await seq.compare({ projectId: 'p1' })
    expect(exportsOf('gex44')).toHaveLength(2)
  })

  it('two different setups compare independently', async () => {
    const other = join(root, 'other')
    git(root, 'clone', '-q', local, other)
    commit(other, 'o1')
    const second = setup({ id: 'box2', hostId: 'ssh:other', connectionId: 'other', path: other, createdAt: 3 })
    const pairs = byId(await service(['git.replicaBundle'], [localSetup(), sshSetup(), second]).compare({ projectId: 'p1' }))
    expect(exportsOf('gex44')).toHaveLength(1)
    expect(exportsOf('other')).toHaveLength(1)
    expect(pairs.get('box')?.relation.kind).toBe('same')
    expect(pairs.get('box2')?.relation).toMatchObject({ kind: 'behind', count: 1 })
  })

  it('an error inside one setup is that setup\'s unknown and never drops the others', async () => {
    commit(remote, 'r1')
    const bad = setup({ id: 'bad', hostId: 'ssh:bad', connectionId: 'bad', path: remote, createdAt: 3 })
    const svc = service(['git.replicaBundle'], [localSetup(), sshSetup(), bad], {
      beforeRequest: (id, method) => {
        if (id === 'bad' && method === 'git.replicaBundleExport') {
          throw new Error('connection reset')
        }
      }
    })
    const pairs = byId(await svc.compare({ projectId: 'p1' }))
    expect(pairs.get('bad')?.relation).toEqual({ kind: 'unknown', reason: 'transfer-interrupted' })
    expect(pairs.get('bad')?.healthy).toBe(false)
    expect(pairs.get('box')?.relation).toMatchObject({ kind: 'behind', count: 1 })
  })

  it('stages the bundle in the private tmpdir while it transfers and leaves nothing after', async () => {
    commit(remote, 'r1')
    const during: boolean[] = []
    const svc = service(['git.replicaBundle'], [localSetup(), sshSetup()], {
      beforeRequest: (_id, method) => {
        if (method === 'git.replicaBundleRead') {
          during.push(readdirSync(scratch).some((n) => n.startsWith('orca-replica-recv-')))
        }
      }
    })
    await svc.compare({ projectId: 'p1' })
    // Station control: the scratch dir was observably in use, so the empty listing after is a real absence.
    expect(during.length).toBeGreaterThan(0)
    expect(during.every(Boolean)).toBe(true)
    expect(readdirSync(scratch).filter((n) => n.startsWith('orca-replica-recv-'))).toEqual([])
  })

  it('hosts that differ only in punctuation derive different host keys; the same host derives one key', () => {
    expect(replicaHostKey('ssh:a/b')).not.toBe(replicaHostKey('ssh:a_b'))
    expect(replicaHostKey('ssh:a.b')).not.toBe(replicaHostKey('ssh:a-b'))
    expect(replicaHostKey('ssh:a/b')).toBe(replicaHostKey('ssh:a/b'))
  })
})

describe('relations: re-fenced on every read', () => {
  const countingReader = () => {
    const reader = { reads: 0 }
    const read: typeof readLocalReplicaFacts = (args) => {
      reader.reads += 1
      return readLocalReplicaFacts(args)
    }
    return { reader, read }
  }
  const only = async (svc: ReturnType<typeof service>, setupId: string) => {
    const res = await svc.relations()
    expect(res.status).toBe('ok')
    return res.pairs.find((p) => p.setupId === setupId)
  }

  it('a setup never compared reads not-compared with zero git reads; control: a compared setup reads its relation', async () => {
    commit(remote, 'r1')
    const { reader, read } = countingReader()
    const svc = service(['git.replicaBundle'], [localSetup(), sshSetup()], undefined, read)
    expect((await only(svc, 'box'))?.relation).toEqual({ kind: 'unknown', reason: 'not-compared' })
    expect(reader.reads).toBe(0)
    expect(log).toEqual([])

    await svc.compare({ projectId: 'p1' })
    const afterCompare = reader.reads
    expect((await only(svc, 'box'))?.relation).toMatchObject({ kind: 'behind', count: 1 })
    expect(reader.reads - afterCompare).toBe(1)
  })

  it('a local commit after the comparison reads evidence-stale, never the old relation', async () => {
    commit(remote, 'r1')
    const svc = service(['git.replicaBundle'], [localSetup(), sshSetup()])
    await svc.compare({ projectId: 'p1' })
    expect((await only(svc, 'box'))?.relation.kind).toBe('behind')
    commit(local, 'l-moved')
    const stale = await only(svc, 'box')
    expect(stale?.relation).toEqual({ kind: 'unknown', reason: 'evidence-stale' })
    expect(stale?.healthy).toBe(false)
  })

  it('a stored failure is re-fenced too: relay-too-old holds until the local tip moves', async () => {
    const svc = service(['git.exec'], [localSetup(), sshSetup()])
    await svc.compare({ projectId: 'p1' })
    expect((await only(svc, 'box'))?.relation).toEqual({ kind: 'unknown', reason: 'relay-too-old' })
    commit(local, 'l-moved')
    expect((await only(svc, 'box'))?.relation).toEqual({ kind: 'unknown', reason: 'evidence-stale' })
  })

  it('a setup removed from the store is pruned and does not come back with its old answer', async () => {
    commit(remote, 'r1')
    const setups = [localSetup(), sshSetup()]
    const svc = service(['git.replicaBundle'], setups)
    await svc.compare({ projectId: 'p1' })
    setups.splice(1, 1)
    expect((await svc.relations()).pairs).toEqual([])
    setups.push(sshSetup())
    expect((await only(svc, 'box'))?.relation).toEqual({ kind: 'unknown', reason: 'not-compared' })
  })

  it('structural arms are derived from the setup list on every read, with no git', async () => {
    const { reader, read } = countingReader()
    const rt = setup({ id: 'rt', hostId: 'runtime:env1', path: remote, createdAt: 2 })
    const lone = setup({ id: 'lone', projectId: 'p2', hostId: 'ssh:z', connectionId: 'z', path: remote })
    const lone2 = setup({ id: 'lone2', projectId: 'p2', hostId: 'ssh:y', connectionId: 'y', path: remote, createdAt: 2 })
    const svc = service(['git.replicaBundle'], [localSetup(), rt, lone, lone2], undefined, read)
    expect((await only(svc, 'rt'))?.relation).toEqual({ kind: 'unknown', reason: 'transport-unsupported-host' })
    expect((await only(svc, 'lone2'))?.relation).toEqual({ kind: 'unknown', reason: 'no-comparison-site' })
    expect(reader.reads).toBe(0)
  })

  it('equal tips under a dirty local anchor publish as unknown worktree-not-verified-clean', async () => {
    writeFileSync(join(local, 'dirty.txt'), 'x')
    const svc = service(['git.replicaBundle'], [localSetup(), sshSetup()])
    const res = await svc.compare({ projectId: 'p1' })
    expect(res.status === 'ok' && res.pairs[0].relation.kind).toBe('same')
    const published = publishedRelationsOf(res.status === 'ok' ? res.pairs : [])
    expect(published.get('box')).toEqual({ kind: 'unknown', reason: 'worktree-not-verified-clean' })
  })
})
