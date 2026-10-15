import type * as fsPromises from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { gitExecFileAsync } from './git/runner'
import type { ReplicaPairService } from './replica-pair-service'
import {
  anchorState,
  commitFile,
  createPairRig,
  git,
  plantStash,
  refNames,
  setupOf,
  type PairRig
} from './replica-pair-test-rig'

// Pass-through runner that records every call and can fail the merge-tree probe on demand.
const spy = vi.hoisted(() => ({
  gitCalls: [] as string[][],
  failMergeTree: false,
  write: null as unknown
}))
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
      if (spy.failMergeTree && argv[0] === 'merge-tree') {
        return Promise.reject(new Error('git: merge-tree --write-tree is not supported'))
      }
      return real.gitExecFileAsync(argv, options)
    }
  }
})

let rig: PairRig
let base: string

const service = (): ReplicaPairService => rig.service()

beforeEach(() => {
  spy.gitCalls = []
  spy.failMergeTree = false
  spy.write = null
  rig = createPairRig()
  base = git(rig.local, 'rev-parse', 'HEAD')
  plantStash(rig.local)
})
afterEach(() => rig.dispose())

const divergeCleanly = (): { local: string; remote: string } => ({
  local: commitFile(rig.local, 'l.txt', 'l\n'),
  remote: commitFile(rig.remote, 'r.txt', 'r\n')
})
const divergeConflicting = (): { local: string; remote: string } => ({
  local: commitFile(rig.local, 'a.txt', 'local side\n'),
  remote: commitFile(rig.remote, 'a.txt', 'remote side\n')
})
const divergenceRefs = (): string[] => refNames(rig.local, 'refs/orca/divergence')
const noCalls = (): void => {
  expect(rig.relayLog).toEqual([])
  expect(spy.gitCalls).toEqual([])
}
const relationOf = async (svc: ReplicaPairService) =>
  (await svc.relations()).pairs.find((p) => p.setupId === 'box')?.relation

describe('preserveDivergence', () => {
  it('creates two refs at the two tips, reports a clean merge, and leaves the anchor byte-identical', async () => {
    const tips = divergeCleanly()
    const before = anchorState(rig.local)
    const result = await service().preserveDivergence({ setupId: 'box' })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') {
      return
    }
    expect(result.refs.local).toMatch(
      new RegExp(
        `^refs/orca/divergence/[A-Za-z0-9._-]+/${tips.local.slice(0, 12)}-${tips.remote.slice(0, 12)}/local$`
      )
    )
    expect(result.refs.remote).toBe(result.refs.local.replace(/\/local$/, '/remote'))
    expect(git(rig.local, 'rev-parse', result.refs.local)).toBe(tips.local)
    expect(git(rig.local, 'rev-parse', result.refs.remote)).toBe(tips.remote)
    expect(result.mergeBase).toBe(base)
    expect(result.conflict).toEqual({ kind: 'clean' })
    expect(result.alreadyPreserved).toBe(false)
    expect(divergenceRefs().sort()).toEqual([result.refs.local, result.refs.remote].sort())
    expect(anchorState(rig.local)).toBe(before)
  })

  it('a second call with unchanged tips is alreadyPreserved and writes nothing (control for the first)', async () => {
    divergeCleanly()
    const svc = service()
    const first = await svc.preserveDivergence({ setupId: 'box' })
    const refs = divergenceRefs().map((r) => `${r}=${git(rig.local, 'rev-parse', r)}`)
    const before = anchorState(rig.local)
    const second = await svc.preserveDivergence({ setupId: 'box' })
    expect(first).toMatchObject({ status: 'ok', alreadyPreserved: false })
    expect(second).toMatchObject({ status: 'ok', alreadyPreserved: true })
    expect(divergenceRefs().map((r) => `${r}=${git(rig.local, 'rev-parse', r)}`)).toEqual(refs)
    expect(anchorState(rig.local)).toBe(before)
  })

  it('refuses ref-occupied when a divergence ref sits at another sha, and leaves that ref unchanged', async () => {
    const tips = divergeCleanly()
    const first = await service().preserveDivergence({ setupId: 'box' })
    if (first.status !== 'ok') {
      throw new Error('control failed')
    }
    // Move the remote side's ref (delete then recreate elsewhere) to model another writer's ref.
    git(rig.local, 'update-ref', '-d', first.refs.remote)
    git(rig.local, 'update-ref', first.refs.remote, base)
    const before = anchorState(rig.local)
    const result = await service().preserveDivergence({ setupId: 'box' })
    expect(result).toEqual({ status: 'refused', reason: 'ref-occupied' })
    expect(git(rig.local, 'rev-parse', first.refs.remote)).toBe(base)
    expect(git(rig.local, 'rev-parse', first.refs.local)).toBe(tips.local)
    expect(anchorState(rig.local)).toBe(before)
  })

  it('reports the conflicted paths, sorted, when both tips edit the same lines', async () => {
    divergeConflicting()
    commitFile(rig.local, 'b.txt', 'b\n')
    const before = anchorState(rig.local)
    const result = await service().preserveDivergence({ setupId: 'box' })
    expect(result).toMatchObject({
      status: 'ok',
      conflict: { kind: 'conflicted', paths: ['a.txt'] }
    })
    expect(anchorState(rig.local)).toBe(before)
  })

  it('a merge-tree that cannot run is conflict unknown with a reason, never clean', async () => {
    divergeCleanly()
    spy.failMergeTree = true
    const result = await service().preserveDivergence({ setupId: 'box' })
    expect(result).toMatchObject({
      status: 'ok',
      conflict: { kind: 'unknown', reason: 'merge-tree-failed' }
    })
    expect(JSON.stringify(result)).not.toContain('clean')
    // Control: with the probe working the same pair is clean.
    spy.failMergeTree = false
    expect(await service().preserveDivergence({ setupId: 'box' })).toMatchObject({
      status: 'ok',
      conflict: { kind: 'clean' },
      alreadyPreserved: true
    })
  })

  it('compares afresh: a stored relation that has gone stale is never the basis', async () => {
    const svc = service()
    // The pair is compared while it is merely `same`; it diverges afterwards, with no compare in between.
    expect(await relationOf(svc)).toMatchObject({ kind: 'unknown', reason: 'not-compared' })
    await svc.compare({ projectId: 'p1' })
    expect(await relationOf(svc)).toMatchObject({ kind: 'same' })
    divergeCleanly()
    expect(await svc.preserveDivergence({ setupId: 'box' })).toMatchObject({
      status: 'ok',
      alreadyPreserved: false
    })
    expect(await relationOf(svc)).toMatchObject({ kind: 'diverged' })
  })
})

describe('preserveDivergence refuses a pair that is not diverged, and writes no ref', () => {
  const refuses = async (relation: string): Promise<void> => {
    const before = anchorState(rig.local)
    expect(await service().preserveDivergence({ setupId: 'box' })).toEqual({
      status: 'refused',
      reason: 'not-diverged',
      relation
    })
    expect(divergenceRefs()).toEqual([])
    expect(anchorState(rig.local)).toBe(before)
  }

  it('same', async () => {
    await refuses('same')
  })

  it('ahead (the anchor holds commits the replica lacks)', async () => {
    commitFile(rig.local, 'l.txt', 'l\n')
    await refuses('ahead')
  })

  it('behind', async () => {
    commitFile(rig.remote, 'r.txt', 'r\n')
    await refuses('behind')
  })

  it('unrelated histories', async () => {
    const other = join(rig.root, 'other')
    git(rig.root, 'init', '-q', '-b', 'main', other)
    commitFile(other, 'z.txt', 'z\n')
    rig.setups[1] = { ...rig.setups[1], path: other }
    await refuses('unrelated')
  })

  it('unknown (an anchor with no commit yet)', async () => {
    const empty = join(rig.root, 'empty')
    git(rig.root, 'init', '-q', '-b', 'main', empty)
    rig.setups[0] = { ...rig.setups[0], path: empty }
    expect(await service().preserveDivergence({ setupId: 'box' })).toEqual({
      status: 'refused',
      reason: 'not-diverged',
      relation: 'unknown'
    })
  })
})

describe('preserveDivergence refusals decide from the stored setup, with no git and no relay call', () => {
  const control = async (svc: ReplicaPairService): Promise<void> => {
    spy.gitCalls = []
    rig.relayLog.length = 0
    divergeCleanly()
    expect(await svc.preserveDivergence({ setupId: 'box' })).toMatchObject({ status: 'ok' })
  }

  it('the anchor setup, and any other setup on this machine, is anchor-setup', async () => {
    rig.setups.push(setupOf({ id: 'also-local', hostId: 'local', path: rig.local, createdAt: 3 }))
    const svc = service()
    for (const setupId of ['anchor', 'also-local']) {
      expect(await svc.preserveDivergence({ setupId })).toEqual({
        status: 'refused',
        reason: 'anchor-setup'
      })
    }
    noCalls()
    await control(svc)
  })

  it('a runtime-owned setup is remote-runtime-unsupported', async () => {
    rig.setups.push(
      setupOf({
        id: 'owned',
        hostId: 'ssh:gex44',
        connectionId: 'gex44',
        path: rig.remote,
        runtimeOwnerEnvironmentId: 'env-1'
      })
    )
    const svc = service()
    expect(await svc.preserveDivergence({ setupId: 'owned' })).toEqual({
      status: 'refused',
      reason: 'remote-runtime-unsupported'
    })
    noCalls()
    await control(svc)
  })

  it('a folder workspace is not-a-git-repo', async () => {
    const svc = service()
    rig.setups[1] = { ...rig.setups[1], kind: 'folder' }
    expect(await svc.preserveDivergence({ setupId: 'box' })).toEqual({
      status: 'refused',
      reason: 'not-a-git-repo'
    })
    noCalls()
    rig.setups[1] = { ...rig.setups[1], kind: undefined }
    await control(svc)
  })

  it('an unknown setup id is not-found', async () => {
    const svc = service()
    expect(await svc.preserveDivergence({ setupId: 'nope' })).toEqual({
      status: 'not-found',
      reason: 'unknown-setup'
    })
    noCalls()
    await control(svc)
  })

  it('an anchor path that no longer exists is worktree-missing', async () => {
    const svc = service()
    const real = rig.setups[0]
    rig.setups[0] = { ...real, path: join(rig.root, 'gone') }
    expect(await svc.preserveDivergence({ setupId: 'box' })).toEqual({
      status: 'refused',
      reason: 'worktree-missing'
    })
    noCalls()
    rig.setups[0] = real
    await control(svc)
  })
})

describe('preserveDivergence under the worktree mutation guard', () => {
  it('is worktree-busy while a sync holds the worktree, never queued, and succeeds once released', async () => {
    commitFile(rig.remote, 'b.txt', 'b\n')
    const svc = service()
    const held = rig.trap('git.replicaBundleExport')
    const syncing = svc.sync({ setupId: 'box' })
    await held.entered
    const refs = divergenceRefs()
    expect(await svc.preserveDivergence({ setupId: 'box' })).toEqual({
      status: 'refused',
      reason: 'worktree-busy'
    })
    expect(divergenceRefs()).toEqual(refs)
    expect(rig.guard.activeCount()).toBe(1)
    held.release()
    expect(await syncing).toMatchObject({ status: 'ok' })
    expect(rig.guard.activeCount()).toBe(0)
  })
})

describe('preserveDivergence comparison failures stay failures', () => {
  it('a reset connection is failed/compare-transfer-interrupted with no cause key and no ref', async () => {
    divergeCleanly()
    rig.state.failOn = (m) =>
      m === 'git.replicaBundleExport'
        ? Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
        : null
    const before = anchorState(rig.local)
    const result = await service().preserveDivergence({ setupId: 'box' })
    expect(result).toEqual({ status: 'failed', reason: 'compare-transfer-interrupted' })
    expect('cause' in result).toBe(false)
    expect(divergenceRefs()).toEqual([])
    expect(anchorState(rig.local)).toBe(before)
  })

  it('a full local disk at the bundle write is failed/compare-transfer-interrupted with cause disk-full', async () => {
    divergeCleanly()
    spy.write = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
    const before = anchorState(rig.local)
    expect(await service().preserveDivergence({ setupId: 'box' })).toEqual({
      status: 'failed',
      reason: 'compare-transfer-interrupted',
      cause: 'disk-full'
    })
    expect(divergenceRefs()).toEqual([])
    expect(anchorState(rig.local)).toBe(before)
  })

  it('no live multiplexer is failed/compare-relay-unsupported and nothing reaches the relay', async () => {
    divergeCleanly()
    rig.state.muxAvailable = false
    expect(await service().preserveDivergence({ setupId: 'box' })).toEqual({
      status: 'failed',
      reason: 'compare-relay-unsupported'
    })
    expect(rig.relayLog).toEqual([])
    expect(divergenceRefs()).toEqual([])
  })

  it('a divergence preserved on a replica that is later unreachable leaves the refs alone', async () => {
    divergeCleanly()
    const svc = service()
    await svc.preserveDivergence({ setupId: 'box' })
    const refs = divergenceRefs()
    rig.state.muxAvailable = false
    expect(await svc.preserveDivergence({ setupId: 'box' })).toMatchObject({ status: 'failed' })
    expect(divergenceRefs()).toEqual(refs)
  })
})
