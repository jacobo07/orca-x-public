import { mkdirSync, writeFileSync } from 'node:fs'
import type * as fsPromises from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gitExecFileAsync } from './git/runner'
import type { CapsuleGitRun } from './replica-capsule'
import { localCapsuleGit } from './replica-capsule-git'
import type { ReplicaPairService } from './replica-pair-service'
import {
  anchorState,
  commitFile,
  createPairRig,
  git,
  plantStash,
  porcelain,
  refNames,
  setupOf,
  type PairRig
} from './replica-pair-test-rig'
import type { GitRun } from './replica-sync'

// Pass-through fakes: every git call is recorded, and a test can arm an ENOSPC on the local bundle write.
const spy = vi.hoisted(() => ({ gitCalls: [] as string[][], write: null as unknown }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof fsPromises>()
  return {
    ...real,
    open: async (...args: Parameters<typeof fsPromises.open>) => {
      const handle = await real.open(...args)
      return new Proxy(handle, {
        get(target, key) {
          if (key === 'write' && spy.write) {
            return () => Promise.reject(spy.write)
          }
          const value = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
    }
  }
})
vi.mock('./git/runner', async (importOriginal) => {
  const real = await importOriginal<
    Record<string, unknown> & { gitExecFileAsync: typeof gitExecFileAsync }
  >()
  return {
    ...real,
    gitExecFileAsync: (argv: string[], options: Parameters<typeof gitExecFileAsync>[1]) => {
      spy.gitCalls.push(argv)
      return real.gitExecFileAsync(argv, options)
    }
  }
})

let rig: PairRig
let base: string
let injected: string[][]

const countingGit: GitRun = (argv, options) => {
  injected.push(argv)
  return gitExecFileAsync(argv, options)
}
const countingCapsuleGit: CapsuleGitRun = (argv, options) => {
  injected.push(argv)
  return localCapsuleGit(argv, options)
}

const service = (over: Parameters<PairRig['service']>[0] = {}): ReplicaPairService =>
  rig.service({ git: countingGit, capsuleGit: countingCapsuleGit, ...over })

beforeEach(() => {
  spy.gitCalls = []
  spy.write = null
  injected = []
  rig = createPairRig()
  base = git(rig.local, 'rev-parse', 'HEAD')
})
afterEach(() => rig.dispose())

const head = (): string => git(rig.local, 'rev-parse', 'HEAD')
const noCalls = (): void => {
  expect(rig.relayLog).toEqual([])
  expect(spy.gitCalls).toEqual([])
  expect(injected).toEqual([])
}
const comparedPair = async (svc: ReplicaPairService, setupId?: string) => {
  const res = await svc.compare({ projectId: 'p1', ...(setupId ? { setupId } : {}) })
  if (res.status !== 'ok') {
    throw new Error(`compare answered ${res.status}`)
  }
  return res.pairs[0]
}
const relationOf = async (svc: ReplicaPairService) =>
  (await svc.relations()).pairs.find((p) => p.setupId === 'box')

describe('sync', () => {
  it('fast-forwards a clean anchor to the remote tip over the relay session', async () => {
    const tip = commitFile(rig.remote, 'b.txt', 'b\n')
    const result = await service().sync({ setupId: 'box' })
    expect(result).toEqual({ status: 'ok', from: base, to: tip })
    expect(head()).toBe(tip)
    expect(porcelain(rig.local)).toBe('')
    expect(refNames(rig.local, 'refs/orca/capsules')).toEqual([])
    expect(rig.relayLog[0]).toBe('relay.status')
  })

  it('an operation in progress at the anchor is a distinct closed failure and HEAD does not move (WR-01)', async () => {
    commitFile(rig.remote, 'b.txt', 'b\n')
    mkdirSync(join(rig.local, '.git', 'rebase-merge'))
    const result = await service().sync({ setupId: 'box' })
    expect(result).toEqual({ status: 'failed', reason: 'operation-in-progress' })
    expect(head()).toBe(base)
    expect(refNames(rig.local, 'refs/orca/capsules')).toEqual([])
  })

  it('a dirty anchor is captured first: the working tree is unchanged and the capsule commit exists', async () => {
    const tip = commitFile(rig.remote, 'b.txt', 'b\n')
    writeFileSync(join(rig.local, 'a.txt'), 'edited\n')
    const before = porcelain(rig.local)
    const result = await service().sync({ setupId: 'box' })
    expect(result).toMatchObject({ status: 'ok', from: base, to: tip })
    const capsuleRef = result.status === 'ok' ? result.capsuleRef : undefined
    expect(capsuleRef).toMatch(/^refs\/orca\/capsules\//)
    expect(refNames(rig.local, 'refs/orca/capsules')).toEqual([capsuleRef])
    expect(git(rig.local, 'cat-file', '-t', capsuleRef!)).toBe('commit')
    expect(head()).toBe(tip)
    expect(porcelain(rig.local)).toBe(before)
  })
})

describe('sync refusals decide from the stored setup, with no git and no relay call', () => {
  const control = async (svc: ReplicaPairService): Promise<void> => {
    spy.gitCalls = []
    injected = []
    rig.relayLog.length = 0
    commitFile(rig.remote, `ctl-${Math.random().toString(36).slice(2)}.txt`, 'c\n')
    expect(await svc.sync({ setupId: 'box' })).toMatchObject({ status: 'ok' })
  }

  it('the anchor setup itself, and any other setup on this machine, is anchor-setup', async () => {
    rig.setups.push(setupOf({ id: 'also-local', hostId: 'local', path: rig.local, createdAt: 3 }))
    const svc = service()
    expect(await svc.sync({ setupId: 'anchor' })).toEqual({
      status: 'refused',
      reason: 'anchor-setup'
    })
    expect(await svc.sync({ setupId: 'also-local' })).toEqual({
      status: 'refused',
      reason: 'anchor-setup'
    })
    noCalls()
    await control(svc)
  })

  it('a runtime-owned setup is remote-runtime-unsupported, even on an ssh host id', async () => {
    rig.setups.push(
      setupOf({
        id: 'owned',
        hostId: 'ssh:gex44',
        connectionId: 'gex44',
        path: rig.remote,
        runtimeOwnerEnvironmentId: 'env-1'
      }),
      setupOf({ id: 'rt', hostId: 'runtime:env-2', path: rig.remote })
    )
    const svc = service()
    expect(await svc.sync({ setupId: 'owned' })).toEqual({
      status: 'refused',
      reason: 'remote-runtime-unsupported'
    })
    expect(await svc.sync({ setupId: 'rt' })).toEqual({
      status: 'refused',
      reason: 'remote-runtime-unsupported'
    })
    noCalls()
    await control(svc)
  })

  it('an anchor owned by a remote runtime is remote-runtime-unsupported, not a worktree to move', async () => {
    const svc = service()
    rig.setups[0] = { ...rig.setups[0], runtimeOwnerEnvironmentId: 'env-9' }
    expect(await svc.sync({ setupId: 'box' })).toEqual({
      status: 'refused',
      reason: 'remote-runtime-unsupported'
    })
    noCalls()
    rig.setups[0] = { ...rig.setups[0], runtimeOwnerEnvironmentId: undefined }
    await control(svc)
  })

  it('a folder workspace on either side is not-a-git-repo', async () => {
    const svc = service()
    rig.setups[1] = { ...rig.setups[1], kind: 'folder' }
    expect(await svc.sync({ setupId: 'box' })).toEqual({
      status: 'refused',
      reason: 'not-a-git-repo'
    })
    rig.setups[1] = { ...rig.setups[1], kind: undefined }
    rig.setups[0] = { ...rig.setups[0], kind: 'folder' }
    expect(await svc.sync({ setupId: 'box' })).toEqual({
      status: 'refused',
      reason: 'not-a-git-repo'
    })
    noCalls()
    rig.setups[0] = { ...rig.setups[0], kind: undefined }
    await control(svc)
  })

  it('an anchor path that no longer exists is worktree-missing', async () => {
    const svc = service()
    const real = rig.setups[0]
    rig.setups[0] = { ...real, path: join(rig.root, 'gone') }
    expect(await svc.sync({ setupId: 'box' })).toEqual({
      status: 'refused',
      reason: 'worktree-missing'
    })
    noCalls()
    rig.setups[0] = real
    await control(svc)
  })

  it('an unknown setup id is not-found and a project with no local setup has no anchor', async () => {
    const svc = service()
    expect(await svc.sync({ setupId: 'nope' })).toEqual({
      status: 'not-found',
      reason: 'unknown-setup'
    })
    const real = rig.setups[0]
    rig.setups.splice(0, 1)
    expect(await svc.sync({ setupId: 'box' })).toEqual({
      status: 'refused',
      reason: 'no-local-anchor'
    })
    noCalls()
    rig.setups.unshift(real)
    await control(svc)
  })
})

describe('sync failures keep their primitive reason and cause, and never move HEAD', () => {
  const connectionReset = (): Error =>
    Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
  const diskFull = (): Error =>
    Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })

  it('a relay that resets the connection is compare-transfer-interrupted with no cause key', async () => {
    commitFile(rig.remote, 'b.txt', 'b\n')
    rig.state.failOn = (m) => (m === 'git.replicaBundleExport' ? connectionReset() : null)
    const result = await service().sync({ setupId: 'box' })
    expect(result).toEqual({ status: 'failed', reason: 'compare-transfer-interrupted' })
    expect('cause' in result).toBe(false)
    expect(head()).toBe(base)
  })

  it('a full local disk at the bundle write is compare-transfer-interrupted with cause disk-full', async () => {
    commitFile(rig.remote, 'b.txt', 'b\n')
    spy.write = diskFull()
    const result = await service().sync({ setupId: 'box' })
    expect(result).toEqual({
      status: 'failed',
      reason: 'compare-transfer-interrupted',
      cause: 'disk-full'
    })
    expect(head()).toBe(base)
  })

  it('no live multiplexer is compare-relay-unsupported and nothing reaches the relay', async () => {
    commitFile(rig.remote, 'b.txt', 'b\n')
    rig.state.muxAvailable = false
    const result = await service().sync({ setupId: 'box' })
    expect(result).toEqual({ status: 'failed', reason: 'compare-relay-unsupported' })
    expect(rig.relayLog).toEqual([])
    expect(head()).toBe(base)
  })

  it('a generation that changes between the comparison and the fast-forward is stale-generation', async () => {
    commitFile(rig.remote, 'b.txt', 'b\n')
    rig.state.failOn = (m) => {
      if (m === 'git.replicaBundleRelease') {
        rig.state.generation = 2
      }
      return null
    }
    const result = await service().sync({ setupId: 'box' })
    expect(result).toEqual({ status: 'failed', reason: 'stale-generation' })
    expect(head()).toBe(base)
  })

  it('disk-full, disconnect and stale-generation are pairwise distinguishable by (reason, cause)', async () => {
    commitFile(rig.remote, 'b.txt', 'b\n')
    const svc = service()
    const seen: string[] = []
    const word = (r: Awaited<ReturnType<ReplicaPairService['sync']>>): string =>
      r.status === 'failed' ? `${r.reason}/${r.cause ?? '-'}` : r.status
    rig.state.failOn = (m) => (m === 'git.replicaBundleExport' ? connectionReset() : null)
    seen.push(word(await svc.sync({ setupId: 'box' })))
    rig.state.failOn = null
    spy.write = diskFull()
    seen.push(word(await svc.sync({ setupId: 'box' })))
    spy.write = null
    rig.state.failOn = (m) => {
      if (m === 'git.replicaBundleRelease') {
        rig.state.generation += 1
      }
      return null
    }
    seen.push(word(await svc.sync({ setupId: 'box' })))
    expect(seen).toEqual([
      'compare-transfer-interrupted/-',
      'compare-transfer-interrupted/disk-full',
      'stale-generation/-'
    ])
    expect(new Set(seen).size).toBe(3)
    expect(head()).toBe(base)
  })

  it('a failure of the operation itself is rethrown, not mapped to a refusal, and the guard is released', async () => {
    const svc = service({
      sshSession: {
        getMultiplexer: () => {
          throw new Error('ssh layer exploded')
        },
        getGeneration: () => 1
      }
    })
    await expect(svc.sync({ setupId: 'box' })).rejects.toThrow('ssh layer exploded')
    expect(rig.guard.activeCount()).toBe(0)
  })

  it('a fast-forward that cannot be verified is verify-failed and the stored relation is not left as behind', async () => {
    const tip = commitFile(rig.remote, 'b.txt', 'b\n')
    let merged = false
    const lyingGit: GitRun = async (argv, options) => {
      injected.push(argv)
      if (argv[0] === 'rev-parse' && merged) {
        return { stdout: `${'f'.repeat(40)}\n` }
      }
      const out = await gitExecFileAsync(argv, options)
      merged ||= argv[0] === 'merge'
      return out
    }
    const svc = service({ git: lyingGit })
    await svc.compare({ projectId: 'p1' })
    expect((await relationOf(svc))?.relation.kind).toBe('behind')
    const result = await svc.sync({ setupId: 'box' })
    expect(result).toMatchObject({ status: 'failed', reason: 'verify-failed' })
    expect(head()).toBe(tip)
    expect((await relationOf(svc))?.relation).toEqual({ kind: 'unknown', reason: 'evidence-stale' })
  })
})

describe('sync and the stored relation', () => {
  it('after ok the stored relation is unknown evidence-stale, never behind (control: behind before)', async () => {
    commitFile(rig.remote, 'b.txt', 'b\n')
    const svc = service()
    await svc.compare({ projectId: 'p1' })
    expect((await relationOf(svc))?.relation).toMatchObject({ kind: 'behind', count: 1 })
    expect(await svc.sync({ setupId: 'box' })).toMatchObject({ status: 'ok' })
    const after = await relationOf(svc)
    expect(after?.relation).toEqual({ kind: 'unknown', reason: 'evidence-stale' })
    expect(after?.healthy).toBe(false)
    expect(after).not.toHaveProperty('remoteTip')
  })

  it('a failure that is not not-behind leaves the stored relation alone', async () => {
    commitFile(rig.remote, 'b.txt', 'b\n')
    const svc = service()
    await svc.compare({ projectId: 'p1' })
    rig.state.failOn = (m) => (m === 'git.replicaBundleExport' ? new Error('reset') : null)
    expect(await svc.sync({ setupId: 'box' })).toMatchObject({ status: 'failed' })
    expect((await relationOf(svc))?.relation).toMatchObject({ kind: 'behind' })
  })

  it('not-behind (equal tips) carries the ancestry word and replaces the stored behind with the fresh relation', async () => {
    commitFile(rig.remote, 'b.txt', 'b\n')
    const svc = service()
    await svc.compare({ projectId: 'p1' })
    expect((await relationOf(svc))?.relation.kind).toBe('behind')
    git(rig.remote, 'reset', '-q', '--hard', base)
    const result = await svc.sync({ setupId: 'box' })
    expect(result).toEqual({ status: 'failed', reason: 'not-behind', observedAncestry: 'same' })
    const stored = (await relationOf(svc))?.relation
    expect(stored).toMatchObject({ kind: 'same' })
    const fresh = (await comparedPair(svc, 'box')).relation
    expect(stored).toEqual(fresh)
    expect(head()).toBe(base)
  })

  it('not-behind (diverged) is reported as diverged and the stored relation is replaced, not kept stale', async () => {
    commitFile(rig.remote, 'b.txt', 'b\n')
    const svc = service()
    await svc.compare({ projectId: 'p1' })
    git(rig.remote, 'reset', '-q', '--hard', base)
    commitFile(rig.remote, 'y.txt', 'y\n')
    commitFile(rig.local, 'z.txt', 'z\n')
    expect((await relationOf(svc))?.relation).toEqual({ kind: 'unknown', reason: 'evidence-stale' })
    const result = await svc.sync({ setupId: 'box' })
    expect(result).toEqual({ status: 'failed', reason: 'not-behind', observedAncestry: 'diverged' })
    const stored = (await relationOf(svc))?.relation
    expect(stored).toMatchObject({ kind: 'diverged' })
    expect(stored).toEqual((await comparedPair(svc, 'box')).relation)
  })

  it('an adoption that cannot read the anchor leaves the failure a failure and clears the stored answer', async () => {
    commitFile(rig.remote, 'b.txt', 'b\n')
    let broken = false
    const svc = service({
      readLocalFacts: async (args) => {
        if (broken) {
          throw new Error('anchor unreadable')
        }
        const { readLocalReplicaFacts } = await import('./replica-local-facts')
        return readLocalReplicaFacts(args)
      }
    })
    await svc.compare({ projectId: 'p1' })
    git(rig.remote, 'reset', '-q', '--hard', base)
    broken = true
    expect(await svc.sync({ setupId: 'box' })).toMatchObject({
      status: 'failed',
      reason: 'not-behind'
    })
    broken = false
    expect((await relationOf(svc))?.relation).toEqual({ kind: 'unknown', reason: 'not-compared' })
  })
})

describe('sync under the worktree mutation guard', () => {
  it('a second sync on the same worktree is worktree-busy, never queued, and never reaches the primitive', async () => {
    const tip = commitFile(rig.remote, 'b.txt', 'b\n')
    const svc = service()
    const held = rig.trap('git.replicaBundleExport')
    const first = svc.sync({ setupId: 'box' })
    await held.entered
    const second = await svc.sync({ setupId: 'box' })
    expect(second).toEqual({ status: 'refused', reason: 'worktree-busy' })
    expect(rig.relayLog.filter((m) => m === 'relay.status')).toHaveLength(1)
    expect(rig.guard.activeCount()).toBe(1)
    held.release()
    expect(await first).toMatchObject({ status: 'ok', to: tip })
    expect(rig.guard.activeCount()).toBe(0)
  })

  it('a capsuleCreate racing a sync on the same worktree is worktree-busy (one shared guard)', async () => {
    commitFile(rig.remote, 'b.txt', 'b\n')
    writeFileSync(join(rig.local, 'a.txt'), 'edited\n')
    const svc = service()
    const held = rig.trap('git.replicaBundleExport')
    const syncing = svc.sync({ setupId: 'box' })
    await held.entered
    expect(await svc.capsuleCreate({ setupId: 'anchor' })).toEqual({
      status: 'refused',
      reason: 'worktree-busy'
    })
    held.release()
    expect(await syncing).toMatchObject({ status: 'ok' })
    expect(rig.guard.activeCount()).toBe(0)
  })

  it('a sync racing a capsuleCreate is worktree-busy and the capsule completes', async () => {
    commitFile(rig.remote, 'b.txt', 'b\n')
    writeFileSync(join(rig.local, 'a.txt'), 'edited\n')
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>((resolve) => (enter = resolve))
    const gate = new Promise<void>((resolve) => (release = resolve))
    let blocked = false
    const slowCapsuleGit: CapsuleGitRun = async (argv, options) => {
      if (!blocked) {
        blocked = true
        enter()
        await gate
      }
      return localCapsuleGit(argv, options)
    }
    const svc = service({ capsuleGit: slowCapsuleGit })
    const capsule = svc.capsuleCreate({ setupId: 'anchor' })
    await entered
    expect(await svc.sync({ setupId: 'box' })).toEqual({
      status: 'refused',
      reason: 'worktree-busy'
    })
    release()
    expect(await capsule).toMatchObject({ status: 'ok', outcome: { kind: 'created' } })
    expect(rig.guard.activeCount()).toBe(0)
    expect(rig.relayLog).toEqual([])
  })

  it('leaves no timer behind', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] })
    try {
      commitFile(rig.remote, 'b.txt', 'b\n')
      expect(await service().sync({ setupId: 'box' })).toMatchObject({ status: 'ok' })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('sync byte identity', () => {
  it('a refused or failed sync leaves HEAD, branch, working tree and stash byte-identical', async () => {
    writeFileSync(join(rig.local, 'a.txt'), 'edited\n')
    plantStash(rig.local)
    const before = anchorState(rig.local)
    const svc = service()
    expect(await svc.sync({ setupId: 'anchor' })).toMatchObject({ status: 'refused' })
    rig.state.muxAvailable = false
    expect(await svc.sync({ setupId: 'box' })).toMatchObject({ status: 'failed' })
    expect(anchorState(rig.local)).toBe(before)
  })
})
