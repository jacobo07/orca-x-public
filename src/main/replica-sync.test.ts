import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type * as fsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitReplicaHandler } from '../relay/git-replica-handler'
import { createMockDispatcher, type RelayDispatcher } from '../relay/git-handler-test-setup'
import type { compareWithRelayReplica, ReplicaComparisonRequest } from './replica-comparison-service'
import { fastForwardToDescendant, syncFromRelayReplica, type GitRun } from './replica-sync'
import { localCapsuleGit } from './replica-capsule-git'
import type { CapsuleGitRun } from './replica-capsule'
import { gitExecFileAsync } from './git/runner'
import { resetSshRelayCapabilityCacheForTests } from './ssh/ssh-relay-capabilities'

// Pass-through fakes; a test arms one fault (local bundle write, `git fetch`) or reads the last comparison result.
const fault = vi.hoisted(() => ({ write: null as unknown, fetch: null as unknown, lastComparison: null as unknown }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof fsPromises>()
  return {
    ...real,
    open: async (...args: Parameters<typeof fsPromises.open>) => {
      const handle = await real.open(...args)
      return new Proxy(handle, {
        get(target, key) {
          if (key === 'write' && fault.write) {
            return () => Promise.reject(fault.write)
          }
          const value = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
    }
  }
})
vi.mock('./git/runner', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown> & { gitExecFileAsync: typeof gitExecFileAsync }>()
  return {
    ...real,
    gitExecFileAsync: (argv: string[], options: Parameters<typeof gitExecFileAsync>[1]) =>
      argv[0] === 'fetch' && fault.fetch ? Promise.reject(fault.fetch) : real.gitExecFileAsync(argv, options)
  }
})
vi.mock('./replica-comparison-service', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown> & { compareWithRelayReplica: typeof compareWithRelayReplica }>()
  return {
    ...real,
    compareWithRelayReplica: async (...args: Parameters<typeof compareWithRelayReplica>) => {
      const result = await real.compareWithRelayReplica(...args)
      fault.lastComparison = result
      return result
    }
  }
})

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
let savedTmpdir: string | undefined
beforeEach(() => {
  resetSshRelayCapabilityCacheForTests()
  fault.write = null
  fault.fetch = null
  fault.lastComparison = null
  savedTmpdir = process.env.TMPDIR
  root = mkdtempSync(join(tmpdir(), 'x11-'))
  // The bundle scratch directory lands under os.tmpdir(): keep it inside this test's root.
  mkdirSync(join(root, 'tmp'))
  process.env.TMPDIR = join(root, 'tmp')
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
  if (savedTmpdir === undefined) {
    delete process.env.TMPDIR
  } else {
    process.env.TMPDIR = savedTmpdir
  }
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
    const r = await sync(relay())
    expect(r).toMatchObject({ ok: false, reason: 'not-behind' })
    expect(!r.ok && r.evidence).toBe((fault.lastComparison as { evidence: unknown }).evidence)
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

const errno = (code: string, message: string): Error => Object.assign(new Error(message), { code })
const ffCalls = (calls: string[][]): GitRun => (argv, opts) => {
  calls.push(argv)
  return gitExecFileAsync(argv, opts)
}

describe('the failure cause and the not-behind evidence (row 65)', () => {
  it('a local ENOSPC writing the bundle is compare-transfer-interrupted with cause disk-full, HEAD unmoved', async () => {
    commitFile(remote, 'b.txt', 'b\n')
    fault.write = errno('ENOSPC', 'ENOSPC: no space left on device, write')
    expect(await sync(relay())).toEqual({ ok: false, reason: 'compare-transfer-interrupted', cause: 'disk-full' })
    expect(git(local, 'rev-parse', 'HEAD')).toBe(base)
    expect(capsules(local)).toHaveLength(0)
  })

  it('an ENOSPC in the receive fetch is compare-transfer-interrupted with cause disk-full, no replica ref', async () => {
    commitFile(remote, 'b.txt', 'b\n')
    fault.fetch = errno('ENOSPC', 'Command failed')
    expect(await sync(relay())).toEqual({ ok: false, reason: 'compare-transfer-interrupted', cause: 'disk-full' })
    expect(git(local, 'rev-parse', 'HEAD')).toBe(base)
    expect(git(local, 'for-each-ref', 'refs/orca/replicas')).toBe('')
  })

  it('a thrown comparison error that is a full disk carries the cause', async () => {
    commitFile(remote, 'b.txt', 'b\n')
    const request: ReplicaComparisonRequest = async (m, p, o) => {
      if (m === 'git.replicaBundleExport') {
        throw errno('ENOSPC', 'ENOSPC: no space left on device')
      }
      return relay()(m, p, o)
    }
    expect(await sync(request)).toEqual({ ok: false, reason: 'compare-transfer-interrupted', cause: 'disk-full' })
  })

  it('control: a relay disconnect is compare-transfer-interrupted with no cause key', async () => {
    commitFile(remote, 'b.txt', 'b\n')
    const request: ReplicaComparisonRequest = async (m, p, o) => {
      if (m === 'git.replicaBundleRead') {
        throw errno('ECONNRESET', 'read ECONNRESET')
      }
      return relay()(m, p, o)
    }
    const r = await sync(request)
    expect(r).toEqual({ ok: false, reason: 'compare-transfer-interrupted' })
    expect('cause' in r).toBe(false)
  })

  it('control: a fetch that fails with a disconnect has no cause key', async () => {
    commitFile(remote, 'b.txt', 'b\n')
    fault.fetch = errno('ECONNRESET', 'read ECONNRESET')
    const r = await sync(relay())
    expect(r).toEqual({ ok: false, reason: 'compare-transfer-interrupted' })
    expect('cause' in r).toBe(false)
  })

  it('control: a stale generation is stale-generation with no cause key', async () => {
    commitFile(remote, 'b.txt', 'b\n')
    const r = await sync(relay(), () => 2)
    expect(r).toEqual({ ok: false, reason: 'stale-generation' })
    expect('cause' in r).toBe(false)
    expect(git(local, 'rev-parse', 'HEAD')).toBe(base)
  })

  it('an ENOSPC at the capsule write is capsule-failed with cause disk-full; no merge runs and HEAD is unmoved', async () => {
    commitFile(remote, 'b.txt', 'b\n')
    writeFileSync(join(local, 'a.txt'), 'dirty\n')
    const calls: string[][] = []
    const full: CapsuleGitRun = (argv, opts) =>
      argv.includes('write-tree')
        ? Promise.reject(errno('ENOSPC', 'error: unable to write file: No space left on device'))
        : localCapsuleGit(argv, opts)
    const r = await sync(relay(), () => 1, ffCalls(calls), full)
    expect(r).toEqual({ ok: false, reason: 'capsule-failed', cause: 'disk-full' })
    expect(calls.some((argv) => argv[0] === 'merge')).toBe(false)
    expect(git(local, 'rev-parse', 'HEAD')).toBe(base)
    expect(readFileSync(join(local, 'a.txt'), 'utf8')).toBe('dirty\n')
    expect(capsules(local)).toHaveLength(0)
  })

  it('control: a capsule that fails for another reason is capsule-failed with no cause key', async () => {
    commitFile(remote, 'b.txt', 'b\n')
    writeFileSync(join(local, 'a.txt'), 'dirty\n')
    const broken: CapsuleGitRun = (argv, opts) =>
      argv.includes('write-tree') ? Promise.reject(errno('EACCES', 'permission denied')) : localCapsuleGit(argv, opts)
    const r = await sync(relay(), () => 1, undefined, broken)
    expect(r).toEqual({ ok: false, reason: 'capsule-failed' })
    expect(git(local, 'rev-parse', 'HEAD')).toBe(base)
  })

  it('an ENOSPC at the fast-forward is ff-failed with cause disk-full, capsule kept, HEAD unmoved', async () => {
    commitFile(remote, 'b.txt', 'b\n')
    writeFileSync(join(local, 'untracked.txt'), 'u\n')
    const full: GitRun = (argv, opts) =>
      argv[0] === 'merge'
        ? Promise.reject(Object.assign(new Error('Command failed'), { stderr: 'fatal: No space left on device' }))
        : gitExecFileAsync(argv, opts)
    const r = await sync(relay(), () => 1, full)
    expect(r).toMatchObject({ ok: false, reason: 'ff-failed', cause: 'disk-full' })
    expect(git(local, 'rev-parse', 'HEAD')).toBe(base)
    expect(capsules(local)).toHaveLength(1)
  })

  it('control: a fast-forward refused by a dirty overwrite is ff-failed with no cause key', async () => {
    commitFile(remote, 'a.txt', 'remote change\n')
    writeFileSync(join(local, 'a.txt'), 'dirty\n')
    const r = await sync(relay())
    expect(r).toMatchObject({ ok: false, reason: 'ff-failed' })
    expect('cause' in r).toBe(false)
  })

  it('not-behind returns the comparison evidence object for diverged, ahead and same, and changes nothing', async () => {
    const same = await sync(relay())
    expect(same).toMatchObject({ ok: false, reason: 'not-behind' })
    expect(!same.ok && same.evidence).toBe((fault.lastComparison as { evidence: unknown }).evidence)
    expect(!same.ok && same.evidence?.outcome).toEqual({ ok: true, ancestry: { kind: 'same' } })
    commitFile(local, 'c.txt', 'c\n')
    const ahead = await sync(relay())
    expect(!ahead.ok && ahead.evidence?.outcome).toMatchObject({ ok: true, ancestry: { kind: 'ahead', count: 1 } })
    commitFile(remote, 'b.txt', 'b\n')
    const head = git(local, 'rev-parse', 'HEAD')
    const diverged = await sync(relay())
    expect(!diverged.ok && diverged.evidence?.observedTips[0]).toBe(head)
    expect(!diverged.ok && diverged.evidence?.outcome).toMatchObject({ ok: true, ancestry: { kind: 'diverged' } })
    expect(git(local, 'rev-parse', 'HEAD')).toBe(head)
    expect(capsules(local)).toHaveLength(0)
  })

  it('control: a behind replica succeeds with no evidence and no cause field', async () => {
    const tip = commitFile(remote, 'b.txt', 'b\n')
    expect(await sync(relay())).toEqual({ ok: true, from: base, to: tip })
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

    it('a refused capsule (unmerged index entries, no operation marker) is capsule-failed', async () => {
      const tip = prepare()
      const blob = git(local, 'rev-parse', `${base}:a.txt`)
      execFileSync('git', ['update-index', '--index-info'], {
        cwd: local,
        env: ENV,
        input: ['1', '2', '3'].map((stage) => `100644 ${blob} ${stage}\ta.txt\n`).join('')
      })
      expect(await run(tip)).toEqual({ ok: false, reason: 'capsule-failed' })
      expect(git(local, 'rev-parse', 'HEAD')).toBe(base)
    })

    it('a merge in progress is refused as operation-in-progress before any capsule is cut', async () => {
      const tip = prepare()
      writeFileSync(join(local, '.git', 'MERGE_HEAD'), `${base}\n`)
      expect(await run(tip)).toEqual({ ok: false, reason: 'operation-in-progress' })
      expect(git(local, 'rev-parse', 'HEAD')).toBe(base)
      expect(capsules(local)).toHaveLength(0)
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
