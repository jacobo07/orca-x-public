import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitReplicaHandler } from '../relay/git-replica-handler'
import { createMockDispatcher, type RelayDispatcher } from '../relay/git-handler-test-setup'
import type { ReplicaComparisonRequest } from './replica-comparison-service'
import { fastForwardToDescendant, syncFromRelayReplica, type GitRun } from './replica-sync'
import { localCapsuleGit } from './replica-capsule-git'
import type { CapsuleGitRun } from './replica-capsule'
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

const sync = (request: ReplicaComparisonRequest, gen = () => 1, g?: GitRun, c?: CapsuleGitRun) =>
  syncFromRelayReplica({
    connectionId: 'c',
    generation: 1,
    currentGeneration: gen,
    request,
    localRepoPath: local,
    remoteRepoPath: remote,
    hostKey: 'gex44',
    git: g,
    capsuleGit: c
  })

describe('syncFromRelayReplica', () => {
  it('fast-forwards a clean behind replica with no capsule and no capsule fields', async () => {
    const tip = commitFile(remote, 'b.txt', 'b\n')
    const r = await sync(relay())
    expect(r).toEqual({ ok: true, from: base, to: tip })
    expect(git(local, 'rev-parse', 'HEAD')).toBe(tip)
    expect(capsules(local)).toHaveLength(0)
  })

  it('a dirty tree gets a full capsule (tracked, staged, untracked) before HEAD moves', async () => {
    const tip = commitFile(remote, 'b.txt', 'b\n')
    writeFileSync(join(local, 'a.txt'), 'dirty\n')
    writeFileSync(join(local, 'staged.txt'), 'staged\n')
    git(local, 'add', 'staged.txt')
    writeFileSync(join(local, 'untracked.txt'), 'untracked\n')
    const r = await sync(relay())
    expect(r).toMatchObject({ ok: true, from: base, to: tip })
    if (!r.ok) {
      return
    }
    expect(r.capsuleRef?.startsWith('refs/orca/capsules/')).toBe(true)
    expect(git(local, 'rev-parse', r.capsuleRef!)).toBe(r.capsuleCommit)
    expect(capsules(local)).toEqual([r.capsuleRef])
    const cap = r.capsuleCommit!
    expect(git(local, 'rev-list', '--parents', '-n', '1', cap).split(' ').slice(1)).toHaveLength(3)
    expect(git(local, 'rev-parse', `${cap}^1`)).toBe(base)
    expect(git(local, 'show', `${cap}:a.txt`)).toBe('dirty')
    expect(git(local, 'show', `${cap}^2:staged.txt`)).toBe('staged')
    expect(git(local, 'show', `${cap}^3:untracked.txt`)).toBe('untracked')
    expect(git(local, 'rev-parse', 'HEAD')).toBe(tip)
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
    expect(git(local, 'show', `${cap}^3:new.txt`)).toBe('untracked')
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
    writeFileSync(join(local, 'untracked.txt'), 'u\n')
    const full: GitRun = (argv, opts) =>
      argv[0] === 'merge' ? Promise.reject(new Error('ENOSPC: no space left on device')) : gitExecFileAsync(argv, opts)
    const r = await sync(relay(), () => 1, full)
    expect(r).toMatchObject({ ok: false, reason: 'ff-failed' })
    expect(git(local, 'rev-parse', 'HEAD')).toBe(base)
    expect(capsules(local)).toHaveLength(1)
  })

  it('generation moved while the capsule is cut is stale-generation, capsule kept', async () => {
    commitFile(remote, 'b.txt', 'b\n')
    writeFileSync(join(local, 'untracked.txt'), 'u\n')
    let gen = 1
    const bump: CapsuleGitRun = (argv, opts) => {
      if (argv.includes('update-ref')) {
        gen = 2 // moves while the capsule is being captured
      }
      return localCapsuleGit(argv, opts)
    }
    const r = await sync(relay(), () => gen, undefined, bump)
    expect(r).toMatchObject({ ok: false, reason: 'stale-generation' })
    expect(git(local, 'rev-parse', 'HEAD')).toBe(base)
    expect(capsules(local)).toHaveLength(1)
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

  describe('a capsule that cannot be cut blocks the fast-forward before HEAD moves (D-05)', () => {
    const prepare = (): string => {
      const tip = commitFile(remote, 'b.txt', 'b\n')
      git(local, 'fetch', '-q', remote, 'main')
      writeFileSync(join(local, 'a.txt'), 'dirty\n')
      return tip
    }
    const run = (tip: string, capsuleGit?: CapsuleGitRun) =>
      fastForwardToDescendant({
        repoPath: local,
        expectedLocalTip: base,
        targetTip: tip,
        evidenceGeneration: 1,
        currentGeneration: () => 1,
        capsuleGit
      })

    it('a throwing capsule runner is capsule-failed', async () => {
      const tip = prepare()
      const broken: CapsuleGitRun = (argv, opts) =>
        argv.includes('write-tree') ? Promise.reject(new Error('ENOSPC')) : localCapsuleGit(argv, opts)
      expect(await run(tip, broken)).toEqual({ ok: false, reason: 'capsule-failed' })
      expect(git(local, 'rev-parse', 'HEAD')).toBe(base)
      expect(capsules(local)).toHaveLength(0)
    })

    it('a refused capsule (merge in progress) is capsule-failed', async () => {
      const tip = prepare()
      writeFileSync(join(local, '.git', 'MERGE_HEAD'), `${base}\n`)
      expect(await run(tip)).toEqual({ ok: false, reason: 'capsule-failed' })
      expect(git(local, 'rev-parse', 'HEAD')).toBe(base)
    })

    it('control: the working runner cuts the capsule and moves HEAD', async () => {
      const tip = prepare()
      const r = await run(tip, localCapsuleGit)
      expect(r).toMatchObject({ ok: true, to: tip })
      expect(git(local, 'rev-parse', 'HEAD')).toBe(tip)
      expect(capsules(local)).toHaveLength(1)
    })
  })
})
