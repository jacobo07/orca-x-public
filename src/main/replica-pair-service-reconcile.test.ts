import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gitExecFileAsync } from './git/runner'
import { createCapsule, type CapsuleGitRun } from './replica-capsule'
import { localCapsuleGit } from './replica-capsule-git'
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
import type { GitRun } from './replica-sync'

let rig: PairRig
let base: string
let injected: string[][]
let mergeTreeFault: Error | null

const countingGit: GitRun = (argv, options) => {
  injected.push(argv)
  if (mergeTreeFault && argv[0] === 'merge-tree') {
    return Promise.reject(mergeTreeFault)
  }
  return gitExecFileAsync(argv, options)
}
const countingCapsuleGit: CapsuleGitRun = (argv, options) => {
  injected.push(argv)
  return localCapsuleGit(argv, options)
}
const service = (): ReplicaPairService =>
  rig.service({ git: countingGit, capsuleGit: countingCapsuleGit })

beforeEach(() => {
  injected = []
  mergeTreeFault = null
  rig = createPairRig()
  // Two tracked files on the shared base, so each side can edit its own.
  commitFile(rig.local, 'b.txt', 'b\n')
  git(rig.remote, 'pull', '-q')
  base = git(rig.local, 'rev-parse', 'HEAD')
  plantStash(rig.local)
})
afterEach(() => rig.dispose())

const editLocal = (name = 'a.txt', body = 'local edit\n'): void =>
  writeFileSync(join(rig.local, name), body)

/** Cuts a capsule of the dirty remote worktree and brings it into the anchor's object store, as the transfer step would. */
async function remoteCapsule(name = 'b.txt', body = 'remote edit\n'): Promise<string> {
  writeFileSync(join(rig.remote, name), body)
  const cut = await createCapsule(localCapsuleGit, rig.remote)
  if (cut.kind !== 'created') {
    throw new Error(`remote capsule not created: ${cut.kind}`)
  }
  git(rig.local, 'fetch', '-q', rig.remote, cut.ref)
  return cut.sha
}
const reconciledRefs = (): string[] => refNames(rig.local, 'refs/orca/reconciled')
const noGit = (): void => {
  expect(rig.relayLog).toEqual([])
  expect(injected).toEqual([])
}

describe('reconcile', () => {
  it('merges both dirty sides into a commit under refs/orca/reconciled and leaves the anchor byte-identical', async () => {
    editLocal()
    const remote = await remoteCapsule()
    const before = anchorState(rig.local)
    const result = await service().reconcile({ setupId: 'box', remoteCapsule: remote })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') {
      return
    }
    expect(result.base).toBe(base)
    expect(result.ref).toMatch(/^refs\/orca\/reconciled\//)
    expect(git(rig.local, 'rev-parse', result.ref)).toBe(result.commit)
    expect(git(rig.local, 'show', `${result.commit}:a.txt`)).toBe('local edit')
    expect(git(rig.local, 'show', `${result.commit}:b.txt`)).toBe('remote edit')
    expect(git(rig.local, 'rev-parse', `${result.commit}^{tree}`)).toBe(result.tree)
    expect(
      git(rig.local, 'rev-list', '--parents', '-n', '1', result.commit).split(' ').slice(1)
    ).toEqual([git(rig.local, 'rev-parse', result.localCapsuleRef), remote])
    expect(result.localOmissions).toEqual([])
    expect(result.untrackedNotReconciled).toBe(false)
    expect(refNames(rig.local, 'refs/orca').sort()).toEqual(
      [result.localCapsuleRef, result.ref].sort()
    )
    expect(anchorState(rig.local)).toBe(before)
    expect(rig.relayLog).toEqual([])
  })

  it('re-running with identical inputs returns the same commit and ref, a second apart, and creates nothing', async () => {
    editLocal()
    const remote = await remoteCapsule()
    const svc = service()
    const first = await svc.reconcile({ setupId: 'box', remoteCapsule: remote })
    const refs = refNames(rig.local, 'refs/orca')
    await new Promise((resolve) => setTimeout(resolve, 1100))
    const second = await svc.reconcile({ setupId: 'box', remoteCapsule: remote })
    expect(first.status).toBe('ok')
    expect(second).toEqual(first)
    expect(refNames(rig.local, 'refs/orca')).toEqual(refs)
  })

  it('names what the local capsule left out, which the reconciled commit does not contain', async () => {
    editLocal()
    writeFileSync(join(rig.local, '.env'), 'SECRET=1\n')
    const remote = await remoteCapsule()
    const result = await service().reconcile({ setupId: 'box', remoteCapsule: remote })
    expect(result).toMatchObject({
      status: 'ok',
      localOmissions: [{ reason: 'secret-shaped', path: '.env' }]
    })
    if (result.status === 'ok') {
      expect(git(rig.local, 'ls-tree', '-r', '--name-only', result.commit)).not.toContain('.env')
    }
  })

  it('overlapping edits are failed/conflict with the base and the paths, and no reconciled ref exists', async () => {
    editLocal('a.txt', 'local side\n')
    const remote = await remoteCapsule('a.txt', 'remote side\n')
    const before = anchorState(rig.local)
    expect(await service().reconcile({ setupId: 'box', remoteCapsule: remote })).toEqual({
      status: 'failed',
      reason: 'conflict',
      base,
      conflictedPaths: ['a.txt']
    })
    expect(reconciledRefs()).toEqual([])
    expect(anchorState(rig.local)).toBe(before)
  })
})

describe('reconcile refusals, each with a control that reconciles', () => {
  const control = async (svc: ReplicaPairService, remote: string): Promise<void> => {
    injected = []
    rig.relayLog.length = 0
    expect(await svc.reconcile({ setupId: 'box', remoteCapsule: remote })).toMatchObject({
      status: 'ok'
    })
  }

  it('a malformed sha is invalid-input and costs no git call', async () => {
    editLocal()
    const remote = await remoteCapsule()
    injected = []
    const svc = service()
    for (const bad of [
      '',
      'xyz',
      remote.slice(0, 39),
      remote.toUpperCase(),
      `${remote}0`,
      '--help'
    ]) {
      expect(await svc.reconcile({ setupId: 'box', remoteCapsule: bad })).toEqual({
        status: 'refused',
        reason: 'invalid-input'
      })
    }
    noGit()
    expect(refNames(rig.local, 'refs/orca')).toEqual([])
    await control(svc, remote)
  })

  it('a clean anchor is local-clean and no capsule or reconciled ref is created', async () => {
    const remote = await remoteCapsule()
    const svc = service()
    expect(await svc.reconcile({ setupId: 'box', remoteCapsule: remote })).toEqual({
      status: 'refused',
      reason: 'local-clean'
    })
    expect(refNames(rig.local, 'refs/orca')).toEqual([])
    editLocal()
    await control(svc, remote)
  })

  it('a remote capsule that is not in the local object store is unknown-commit', async () => {
    editLocal()
    const remote = await remoteCapsule()
    const svc = service()
    expect(await svc.reconcile({ setupId: 'box', remoteCapsule: 'f'.repeat(40) })).toEqual({
      status: 'refused',
      reason: 'unknown-commit'
    })
    expect(reconciledRefs()).toEqual([])
    await control(svc, remote)
  })

  it('a remote capsule cut on another base is not-same-base', async () => {
    editLocal()
    const good = await remoteCapsule()
    commitFile(rig.remote, 'c.txt', 'c\n')
    const other = await remoteCapsule('c.txt', 'c edited\n')
    const svc = service()
    expect(await svc.reconcile({ setupId: 'box', remoteCapsule: other })).toEqual({
      status: 'refused',
      reason: 'not-same-base'
    })
    expect(reconciledRefs()).toEqual([])
    await control(svc, good)
  })

  it('a Git without merge-tree --write-tree is merge-tree-unsupported, never a conflict or an ok', async () => {
    editLocal()
    const remote = await remoteCapsule()
    mergeTreeFault = Object.assign(new Error('usage: git merge-tree'), { code: 129 })
    const svc = service()
    expect(await svc.reconcile({ setupId: 'box', remoteCapsule: remote })).toEqual({
      status: 'refused',
      reason: 'merge-tree-unsupported'
    })
    expect(reconciledRefs()).toEqual([])
    mergeTreeFault = null
    await control(svc, remote)
  })

  it('a capsule that cannot be cut surfaces its own word: capsule-unmerged, not-a-git-repo', async () => {
    editLocal()
    const remote = await remoteCapsule()
    const svc = service()
    writeFileSync(join(rig.local, '.git', 'MERGE_HEAD'), `${base}\n`)
    expect(await svc.reconcile({ setupId: 'box', remoteCapsule: remote })).toEqual({
      status: 'refused',
      reason: 'capsule-unmerged'
    })
    const real = rig.setups[0]
    const plain = join(rig.root, 'plain')
    mkdirSync(plain)
    rig.setups[0] = { ...real, path: plain }
    expect(await svc.reconcile({ setupId: 'box', remoteCapsule: remote })).toEqual({
      status: 'refused',
      reason: 'not-a-git-repo'
    })
    expect(reconciledRefs()).toEqual([])
    rig.setups[0] = real
    rmSync(join(rig.local, '.git', 'MERGE_HEAD'))
    await control(svc, remote)
  })
})

describe('reconcile refusals decided from the stored setup, with no git call', () => {
  const ready = async (): Promise<string> => {
    editLocal()
    const remote = await remoteCapsule()
    injected = []
    return remote
  }
  const control = async (svc: ReplicaPairService, remote: string): Promise<void> => {
    expect(await svc.reconcile({ setupId: 'box', remoteCapsule: remote })).toMatchObject({
      status: 'ok'
    })
  }

  it('the anchor setup is anchor-setup', async () => {
    const remote = await ready()
    const svc = service()
    expect(await svc.reconcile({ setupId: 'anchor', remoteCapsule: remote })).toEqual({
      status: 'refused',
      reason: 'anchor-setup'
    })
    noGit()
    await control(svc, remote)
  })

  it('a runtime-owned setup is remote-runtime-unsupported', async () => {
    const remote = await ready()
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
    expect(await svc.reconcile({ setupId: 'owned', remoteCapsule: remote })).toEqual({
      status: 'refused',
      reason: 'remote-runtime-unsupported'
    })
    noGit()
    await control(svc, remote)
  })

  it('a folder workspace is not-a-git-repo', async () => {
    const remote = await ready()
    const svc = service()
    rig.setups[1] = { ...rig.setups[1], kind: 'folder' }
    expect(await svc.reconcile({ setupId: 'box', remoteCapsule: remote })).toEqual({
      status: 'refused',
      reason: 'not-a-git-repo'
    })
    noGit()
    rig.setups[1] = { ...rig.setups[1], kind: undefined }
    await control(svc, remote)
  })

  it('an unknown setup id is not-found', async () => {
    const remote = await ready()
    const svc = service()
    expect(await svc.reconcile({ setupId: 'nope', remoteCapsule: remote })).toEqual({
      status: 'not-found',
      reason: 'unknown-setup'
    })
    noGit()
    await control(svc, remote)
  })

  it('an anchor path that no longer exists is worktree-missing', async () => {
    const remote = await ready()
    const svc = service()
    const real = rig.setups[0]
    rig.setups[0] = { ...real, path: join(rig.root, 'gone') }
    expect(await svc.reconcile({ setupId: 'box', remoteCapsule: remote })).toEqual({
      status: 'refused',
      reason: 'worktree-missing'
    })
    noGit()
    rig.setups[0] = real
    await control(svc, remote)
  })

  it('is worktree-busy while a sync holds the worktree, never queued, and reconciles once released', async () => {
    const remote = await ready()
    commitFile(rig.remote, 'z.txt', 'z\n')
    const svc = service()
    const held = rig.trap('git.replicaBundleExport')
    const syncing = svc.sync({ setupId: 'box' })
    await held.entered
    injected = []
    expect(await svc.reconcile({ setupId: 'box', remoteCapsule: remote })).toEqual({
      status: 'refused',
      reason: 'worktree-busy'
    })
    expect(injected).toEqual([])
    expect(rig.guard.activeCount()).toBe(1)
    held.release()
    await syncing
    expect(rig.guard.activeCount()).toBe(0)
  })
})
