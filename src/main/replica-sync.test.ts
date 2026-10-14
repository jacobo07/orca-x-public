import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitReplicaHandler } from '../relay/git-replica-handler'
import { createMockDispatcher, type RelayDispatcher } from '../relay/git-handler-test-setup'
import type { ReplicaComparisonRequest } from './replica-comparison-service'
import { createCapsule, fastForwardToDescendant, syncFromRelayReplica, type GitRun } from './replica-sync'
import { gitExecFileAsync } from './git/runner'
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
const commitFile = (cwd: string, name: string, body: string): string => {
  writeFileSync(join(cwd, name), body)
  git(cwd, 'add', name)
  git(cwd, 'commit', '-qm', `add ${name}`)
  return git(cwd, 'rev-parse', 'HEAD')
}
const capsules = (repo: string): string[] =>
  git(repo, 'for-each-ref', '--format=%(refname)', 'refs/orca/capsules').split('\n').filter(Boolean)

let root: string
let local: string
let remote: string
let base: string
let d: ReturnType<typeof createMockDispatcher>
let h: GitReplicaHandler
beforeEach(() => {
  resetSshRelayCapabilityCacheForTests()
  root = mkdtempSync(join(tmpdir(), 'x11-'))
  local = join(root, 'local')
  remote = join(root, 'remote')
  git(root, 'init', '-q', '-b', 'main', local)
  base = commitFile(local, 'a.txt', 'a\n')
  git(root, 'clone', '-q', local, remote)
  d = createMockDispatcher()
  h = new GitReplicaHandler(d as unknown as RelayDispatcher)
})
afterEach(async () => {
  await h.dispose()
  rmSync(root, { recursive: true, force: true })
})

const relay =
  (fail?: (method: string) => boolean): ReplicaComparisonRequest =>
  async (method, params) => {
    if (method === 'relay.status') {
      return { capabilities: ['git.replicaBundle'] }
    }
    if (fail?.(method)) {
      throw new Error('disconnected')
    }
    return d.callRequest(method, params)
  }

const sync = (request: ReplicaComparisonRequest, gen = () => 1, g?: GitRun) =>
  syncFromRelayReplica({
    connectionId: 'c',
    generation: 1,
    currentGeneration: gen,
    request,
    localRepoPath: local,
    remoteRepoPath: remote,
    hostKey: 'gex44',
    git: g
  })

describe('syncFromRelayReplica', () => {
  it('fast-forwards a clean behind replica, capsule first', async () => {
    const tip = commitFile(remote, 'b.txt', 'b\n')
    const r = await sync(relay())
    expect(r).toMatchObject({ ok: true, from: base, to: tip })
    expect(git(local, 'rev-parse', 'HEAD')).toBe(tip)
    expect(capsules(local)).toHaveLength(1)
    expect(git(local, 'rev-parse', `${capsules(local)[0]}^`)).toBe(base)
  })

  it('preserves non-conflicting dirty work in the capsule and keeps it in the tree', async () => {
    const tip = commitFile(remote, 'b.txt', 'b\n')
    writeFileSync(join(local, 'a.txt'), 'dirty\n')
    writeFileSync(join(local, 'new.txt'), 'untracked\n')
    const r = await sync(relay())
    expect(r.ok).toBe(true)
    expect(git(local, 'rev-parse', 'HEAD')).toBe(tip)
    const cap = capsules(local)[0]
    expect(git(local, 'show', `${cap}:a.txt`)).toBe('dirty')
    expect(git(local, 'show', `${cap}:new.txt`)).toBe('untracked')
    expect(readFileSync(join(local, 'a.txt'), 'utf8')).toBe('dirty\n')
  })

  it('a dirty file the update would overwrite fails ff-failed, capsule kept, HEAD unmoved', async () => {
    commitFile(remote, 'a.txt', 'remote change\n')
    writeFileSync(join(local, 'a.txt'), 'dirty\n')
    const r = await sync(relay())
    expect(r).toMatchObject({ ok: false, reason: 'ff-failed' })
    expect(git(local, 'rev-parse', 'HEAD')).toBe(base)
    expect(readFileSync(join(local, 'a.txt'), 'utf8')).toBe('dirty\n')
    expect(capsules(local)).toHaveLength(1)
  })

  it('diverged / ahead / same are not-behind and nothing moves', async () => {
    commitFile(remote, 'b.txt', 'b\n')
    commitFile(local, 'c.txt', 'c\n')
    const head = git(local, 'rev-parse', 'HEAD')
    expect(await sync(relay())).toEqual({ ok: false, reason: 'not-behind' })
    expect(git(local, 'rev-parse', 'HEAD')).toBe(head)
    expect(capsules(local)).toHaveLength(0)
  })

  it('disconnect during transfer stays a failure and moves nothing', async () => {
    commitFile(remote, 'b.txt', 'b\n')
    const r = await sync(relay((m) => m === 'git.replicaBundleRead'))
    expect(r.ok).toBe(false)
    expect(git(local, 'rev-parse', 'HEAD')).toBe(base)
    expect(capsules(local)).toHaveLength(0)
  })

  it('old relay fails closed', async () => {
    commitFile(remote, 'b.txt', 'b\n')
    const old: ReplicaComparisonRequest = async (m) => {
      if (m === 'relay.status') {
        return { capabilities: [] }
      }
      throw new Error('never called')
    }
    expect(await sync(old)).toEqual({ ok: false, reason: 'compare-relay-unsupported' })
  })

  it('disk-full during the merge is ff-failed, capsule kept, HEAD unmoved', async () => {
    commitFile(remote, 'b.txt', 'b\n')
    const full: GitRun = (argv, opts) =>
      argv[0] === 'merge' ? Promise.reject(new Error('ENOSPC: no space left on device')) : gitExecFileAsync(argv, opts)
    const r = await sync(relay(), () => 1, full)
    expect(r).toMatchObject({ ok: false, reason: 'ff-failed' })
    expect(git(local, 'rev-parse', 'HEAD')).toBe(base)
    expect(capsules(local)).toHaveLength(1)
  })

  it('generation moved before the merge is stale-generation', async () => {
    commitFile(remote, 'b.txt', 'b\n')
    let gen = 1
    const bump: GitRun = (argv, opts) => {
      if (argv[0] === 'update-ref') {
        gen = 2 // moves while the capsule is being captured
      }
      return gitExecFileAsync(argv, opts)
    }
    const r = await sync(relay(), () => gen, bump)
    expect(r).toMatchObject({ ok: false, reason: 'stale-generation' })
    expect(git(local, 'rev-parse', 'HEAD')).toBe(base)
  })
})

describe('fastForwardToDescendant', () => {
  it('rejects a moved local tip and a non-descendant target', async () => {
    const side = git(local, 'rev-parse', 'HEAD')
    git(local, 'checkout', '-q', '-b', 'other')
    const o = commitFile(local, 'o.txt', 'o\n')
    git(local, 'checkout', '-q', 'main')
    const common = { repoPath: local, evidenceGeneration: 1, currentGeneration: () => 1 }
    expect(await fastForwardToDescendant({ ...common, expectedLocalTip: o, targetTip: o })).toMatchObject({
      reason: 'stale-tip'
    })
    commitFile(local, 'm.txt', 'm\n')
    const head = git(local, 'rev-parse', 'HEAD')
    expect(await fastForwardToDescendant({ ...common, expectedLocalTip: head, targetTip: o })).toMatchObject({
      reason: 'not-descendant'
    })
    expect(await fastForwardToDescendant({ ...common, expectedLocalTip: head, targetTip: 'zz' })).toMatchObject({
      reason: 'invalid-input'
    })
    expect(side).toBeTruthy()
    expect(capsules(local)).toHaveLength(0)
  })

  it('a failing capsule blocks the fast-forward', async () => {
    const tip = commitFile(remote, 'b.txt', 'b\n')
    git(local, 'fetch', '-q', remote, 'main')
    const noCapsule: GitRun = (argv, opts) =>
      argv[0] === 'write-tree' ? Promise.reject(new Error('ENOSPC')) : gitExecFileAsync(argv, opts)
    const r = await fastForwardToDescendant({
      repoPath: local,
      expectedLocalTip: base,
      targetTip: tip,
      evidenceGeneration: 1,
      currentGeneration: () => 1,
      git: noCapsule
    })
    expect(r).toEqual({ ok: false, reason: 'capsule-failed' })
    expect(git(local, 'rev-parse', 'HEAD')).toBe(base)
    expect(await createCapsule(local, noCapsule)).toBeNull()
  })
})
