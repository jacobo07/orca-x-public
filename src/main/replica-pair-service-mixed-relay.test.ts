import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMockDispatcher, type RelayDispatcher } from '../relay/git-handler-test-setup'
import { GitReplicaHandler } from '../relay/git-replica-handler'
import { ReplicaFactsHandler } from '../relay/replica-facts-handler'
import type { ProjectHostSetup } from '../shared/project-types'
import { publishedRelationsOf } from '../shared/replica-pair-view'
import type { WorktreeFact } from '../shared/workspace-replica-state'
import { readRemoteWorktreeFact } from './replica-remote-facts'
import { createReplicaPairService } from './replica-pair-service'
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
const NOT_FOUND = Object.assign(new Error('Method not found'), { code: -32601 })
const FACTS = 'sync.replicaFacts'

type RelayKind = 'capable' | 'old' | 'swapped' | 'hostile'

let root: string
let local: string
let remote: string
let scratch: string
let log: string[]
let seen: WorktreeFact[]
let handlers: { dispose(): Promise<void> }[]
const savedTmp = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP }

// A fake relay over the real replica handlers; `old` has neither sync.v1 nor a sync handler, as a deployed old relay.
function buildService(kind: RelayKind) {
  const d = createMockDispatcher()
  const replica = new GitReplicaHandler(d as unknown as RelayDispatcher)
  handlers.push(replica)
  if (kind === 'capable') {
    void new ReplicaFactsHandler(d as unknown as RelayDispatcher)
  }
  const capabilities = kind === 'old' ? ['git.replicaBundle'] : ['git.replicaBundle', 'sync.v1']
  const request = async (method: string, params?: Record<string, unknown>) => {
    log.push(method)
    if (method === 'relay.status') {
      return { capabilities }
    }
    if (method === FACTS && kind === 'old') {
      throw NOT_FOUND
    }
    if (method === FACTS && kind === 'swapped') {
      throw NOT_FOUND
    }
    if (method === FACTS && kind === 'hostile') {
      return { worktree: 'clean' }
    }
    return d.callRequest(method, params ?? {})
  }
  const setups: ProjectHostSetup[] = [
    base({ id: 'anchor', hostId: 'local', path: local, createdAt: 1 }),
    base({ id: 'box', hostId: 'ssh:gex44', connectionId: 'gex44', path: remote, createdAt: 2 })
  ]
  return createReplicaPairService({
    listProjectHostSetups: () => setups,
    sshSession: {
      getMultiplexer: () => ({ isDisposed: () => false, request }),
      getGeneration: () => 1
    },
    readRemoteWorktreeFact: async (args) => {
      const fact = await readRemoteWorktreeFact(args)
      seen.push(fact)
      return fact
    },
    now: () => 7
  })
}

const base = (
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

async function compared(svc: ReturnType<typeof buildService>) {
  const res = await svc.compare({ projectId: 'p1' })
  if (res.status !== 'ok') {
    throw new Error(`expected ok, got ${res.status}`)
  }
  return { pair: res.pairs[0], published: publishedRelationsOf(res.pairs).get('box') }
}

beforeEach(() => {
  resetSshRelayCapabilityCacheForTests()
  log = []
  seen = []
  handlers = []
  root = mkdtempSync(join(tmpdir(), 'rpsm-'))
  // Why: compare stages bundles under os.tmpdir(); a private one keeps parallel suites that list the shared one honest.
  scratch = join(root, 'scratch')
  mkdirSync(scratch)
  process.env.TMPDIR = process.env.TMP = process.env.TEMP = scratch
  local = join(root, 'local')
  remote = join(root, 'remote')
  git(root, 'init', '-q', '-b', 'main', local)
  commit(local, 'base')
  git(root, 'clone', '-q', local, remote)
})
afterEach(async () => {
  for (const [key, value] of Object.entries(savedTmp)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  await Promise.all(handlers.map((h) => h.dispose()))
  rmSync(root, { recursive: true, force: true })
})

describe('pair service across relay versions', () => {
  it('capable relay: equal clean worktrees are healthy and publish same; the facts request is sent once', async () => {
    const { pair, published } = await compared(buildService('capable'))
    expect(pair.relation.kind).toBe('same')
    expect(pair.healthy).toBe(true)
    expect(published).toMatchObject({ kind: 'same' })
    expect(seen).toEqual([{ kind: 'clean' }])
    expect(log.filter((m) => m === FACTS)).toHaveLength(1)
    expect(log.filter((m) => m === 'relay.status')).toHaveLength(1)
  })

  it('capable relay control: a dirty remote working file is read dirty and publishes unknown worktree-not-verified-clean', async () => {
    writeFileSync(join(remote, 'wip.txt'), 'x')
    const { pair, published } = await compared(buildService('capable'))
    expect(pair.relation.kind).toBe('same')
    expect(pair.healthy).toBe(false)
    expect(seen).toMatchObject([{ kind: 'dirty', untracked: 1 }])
    expect(published).toEqual({ kind: 'unknown', reason: 'worktree-not-verified-clean' })
  })

  it('old relay: no sync.replicaFacts is ever sent; the comparison relation survives', async () => {
    commit(remote, 'r1')
    commit(remote, 'r2')
    const { pair } = await compared(buildService('old'))
    expect(pair.relation).toMatchObject({ kind: 'behind', count: 2 })
    expect(log).toContain('relay.status')
    expect(log).toContain('git.replicaBundleExport')
    expect(log).not.toContain(FACTS)
  })

  it('old relay, equal tips: still same, never healthy, published unknown, reason names the old relay', async () => {
    const { pair, published } = await compared(buildService('old'))
    expect(pair.relation.kind).toBe('same')
    expect(pair.healthy).toBe(false)
    expect(seen).toEqual([{ kind: 'unknown', reason: 'remote-facts-relay-too-old' }])
    expect(published).toEqual({ kind: 'unknown', reason: 'worktree-not-verified-clean' })
    expect(log).not.toContain(FACTS)
    expect(log.filter((m) => m === 'relay.status')).toHaveLength(1)
  })

  it('relay swapped for an older one mid-session: too old, one attempt, cache evicted, never widened', async () => {
    const svc = buildService('swapped')
    const first = await compared(svc)
    expect(first.pair.healthy).toBe(false)
    expect(seen).toEqual([{ kind: 'unknown', reason: 'remote-facts-relay-too-old' }])
    expect(log.filter((m) => m === FACTS)).toHaveLength(1)
    expect(log.filter((m) => m === 'relay.status')).toHaveLength(1)

    await compared(svc)
    // Evicted: the second compare probed relay.status again, and still sent the method once.
    expect(log.filter((m) => m === 'relay.status')).toHaveLength(2)
    expect(log.filter((m) => m === FACTS)).toHaveLength(2)
    expect(log.filter((m) => m.startsWith('sync.') && m !== FACTS)).toEqual([])
    expect(log).not.toContain('git.exec')
  })

  it('a hostile facts answer reads remote-facts-invalid and never healthy', async () => {
    const { pair, published } = await compared(buildService('hostile'))
    expect(seen).toEqual([{ kind: 'unknown', reason: 'remote-facts-invalid' }])
    expect(pair.healthy).toBe(false)
    expect(published).toEqual({ kind: 'unknown', reason: 'worktree-not-verified-clean' })
  })

  it('a pair that is not equal does not read the remote worktree (it cannot be healthy)', async () => {
    commit(remote, 'r1')
    await compared(buildService('capable'))
    expect(log).not.toContain(FACTS)
    expect(seen).toEqual([])
  })
})
