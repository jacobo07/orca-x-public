import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProjectHostSetup } from '../shared/project-types'
import { listCapsules, type CapsuleGitRun } from './replica-capsule'
import { localCapsuleGit } from './replica-capsule-git'
import { createReplicaPairService, type ReplicaPairService } from './replica-pair-service'
import { createReplicaWorktreeMutationGuard } from './replica-worktree-mutation-guard'

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t'
}
const git = (cwd: string, ...a: string[]): string =>
  execFileSync('git', a, { cwd, env: ENV, encoding: 'utf8' }).trim()

let root: string
let a: string
let b: string
let setups: ProjectHostSetup[]
let runnerCalls: string[][]

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

const countingGit: CapsuleGitRun = (argv, options) => {
  runnerCalls.push(argv)
  return localCapsuleGit(argv, options)
}

function service(capsuleGit: CapsuleGitRun = countingGit): ReplicaPairService {
  return createReplicaPairService({
    listProjectHostSetups: () => setups,
    capsuleGit,
    mutationGuard: createReplicaWorktreeMutationGuard()
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-pair-capsule-'))
  a = join(root, 'a')
  git(root, 'init', '-q', '-b', 'main', a)
  writeFileSync(join(a, 'tracked.txt'), 'tracked\n')
  writeFileSync(join(a, 'keep.txt'), 'keep\n')
  git(a, 'add', '.')
  git(a, 'commit', '-qm', 'seed')
  b = join(root, 'b')
  git(root, 'clone', '-q', a, b)
  runnerCalls = []
  setups = [
    setup({ id: 'A', hostId: 'local', path: a }),
    setup({ id: 'B', hostId: 'local', path: b, createdAt: 2 })
  ]
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

// One tracked edit, one staged new file, one untracked file.
function dirtyA(): void {
  writeFileSync(join(a, 'tracked.txt'), 'edited\n')
  writeFileSync(join(a, 'staged.txt'), 'staged\n')
  git(a, 'add', 'staged.txt')
  writeFileSync(join(a, 'untracked.txt'), 'untracked\n')
}

// Stands in for transport: the capsule lives in A's repository until something carries it to B.
function carryToB(ref: string): void {
  git(b, '-c', 'transfer.unpackLimit=100000', 'fetch', '-q', '--no-tags', a, `${ref}:${ref}`)
}

function plantStash(repo: string): void {
  const stash = git(repo, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'someone else wip')
  git(repo, 'update-ref', '--create-reflog', '-m', 'On main: someone else wip', 'refs/stash', stash)
}

function stashState(repo: string): string {
  const log = join(repo, '.git', 'logs', 'refs', 'stash')
  const sha = (p: string): string =>
    existsSync(p) ? createHash('sha1').update(readFileSync(p)).digest('hex') : 'absent'
  return `${git(repo, 'rev-parse', '--verify', '-q', 'refs/stash')}|${sha(join(repo, '.git', 'refs', 'stash'))}|${sha(log)}`
}

function files(repo: string): string {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (name === '.git') {
        continue
      }
      const full = join(dir, name)
      if (lstatSync(full).isDirectory()) {
        walk(full)
      } else {
        out.push(
          `${full.slice(repo.length)}:${createHash('sha1').update(readFileSync(full)).digest('hex')}`
        )
      }
    }
  }
  walk(repo)
  return out.join('\n')
}

const porcelain = (repo: string): string => git(repo, 'status', '--porcelain=v1', '-uall')

async function createdRef(s: ReplicaPairService): Promise<string> {
  const made = await s.capsuleCreate({ setupId: 'A' })
  if (made.status !== 'ok' || made.outcome.kind !== 'created') {
    throw new Error(`capsule not created: ${JSON.stringify(made)}`)
  }
  return made.outcome.ref
}

describe('capsuleCreate', () => {
  it('captures a dirty local git worktree; a second identical call reports alreadyExisted', async () => {
    dirtyA()
    const s = service()
    const first = await s.capsuleCreate({ setupId: 'A' })
    expect(first).toMatchObject({
      status: 'ok',
      outcome: {
        kind: 'created',
        alreadyExisted: false,
        partial: false,
        omissions: [],
        base: git(a, 'rev-parse', 'HEAD')
      }
    })
    const ref = (first as { outcome: { ref: string; sha: string } }).outcome.ref
    expect(ref).toBe(`refs/orca/capsules/${(first as { outcome: { sha: string } }).outcome.sha}`)
    expect(git(a, 'rev-parse', '--verify', ref)).toBe(
      (first as { outcome: { sha: string } }).outcome.sha
    )
    const second = await s.capsuleCreate({ setupId: 'A' })
    expect(second).toMatchObject({
      status: 'ok',
      outcome: { kind: 'created', alreadyExisted: true, ref }
    })
  })

  it('a clean worktree is ok/clean and creates no ref', async () => {
    const res = await service().capsuleCreate({ setupId: 'B' })
    expect(res).toEqual({ status: 'ok', outcome: { kind: 'clean' } })
    expect(git(b, 'for-each-ref', 'refs/orca/capsules')).toBe('')
  })

  it('refuses a worktree with a merge in progress as capsule-unmerged; control: the same tree without it is captured', async () => {
    dirtyA()
    writeFileSync(join(a, '.git', 'MERGE_HEAD'), `${git(a, 'rev-parse', 'HEAD')}\n`)
    await expect(service().capsuleCreate({ setupId: 'A' })).resolves.toEqual({
      status: 'refused',
      reason: 'capsule-unmerged'
    })
    rmSync(join(a, '.git', 'MERGE_HEAD'))
    expect(await service().capsuleCreate({ setupId: 'A' })).toMatchObject({ status: 'ok' })
  })

  it('surfaces capsule-unstable when the worktree moves between the two builds', async () => {
    dirtyA()
    let statuses = 0
    const moving: CapsuleGitRun = (argv, options) => {
      if (argv[0] === 'status' && ++statuses === 3) {
        writeFileSync(join(a, 'appeared-mid-capture.txt'), 'x\n')
      }
      return localCapsuleGit(argv, options)
    }
    await expect(service(moving).capsuleCreate({ setupId: 'A' })).resolves.toEqual({
      status: 'refused',
      reason: 'capsule-unstable'
    })
    // Control: with nothing moving the same worktree is captured.
    expect(await service().capsuleCreate({ setupId: 'A' })).toMatchObject({ status: 'ok' })
  })

  it.each([
    ['ssh host', { hostId: 'ssh:gex44' as const, connectionId: 'gex44' }],
    ['runtime host', { hostId: 'runtime:env-1' as const }],
    ['runtime-owned local row', { hostId: 'local' as const, runtimeOwnerEnvironmentId: 'env-1' }]
  ])('refuses a %s setup by name and runs no git', async (_name, over) => {
    setups = [...setups, setup({ id: 'R', path: a, createdAt: 3, ...over })]
    const s = service()
    const expected = { status: 'refused', reason: 'remote-capsule-unsupported' }
    await expect(s.capsuleCreate({ setupId: 'R' })).resolves.toEqual(expected)
    await expect(s.capsuleList({ setupId: 'R' })).resolves.toEqual(expected)
    await expect(s.capsuleRestore({ setupId: 'R', capsule: 'f'.repeat(40) })).resolves.toEqual(
      expected
    )
    expect(runnerCalls).toEqual([])
    // Control: the local setup of the same path does run git.
    dirtyA()
    expect(await s.capsuleCreate({ setupId: 'A' })).toMatchObject({ status: 'ok' })
    expect(runnerCalls.length).toBeGreaterThan(0)
  })

  it('refuses a folder setup as not-a-git-repo without running git; a plain directory without the kind is refused by the primitive', async () => {
    const plain = join(root, 'plain')
    mkdirSync(plain)
    setups = [
      ...setups,
      setup({ id: 'F', hostId: 'local', path: a, kind: 'folder', createdAt: 3 }),
      setup({ id: 'P', hostId: 'local', path: plain, createdAt: 4 })
    ]
    const s = service()
    const expected = { status: 'refused', reason: 'not-a-git-repo' }
    await expect(s.capsuleCreate({ setupId: 'F' })).resolves.toEqual(expected)
    await expect(s.capsuleList({ setupId: 'F' })).resolves.toEqual(expected)
    await expect(s.capsuleRestore({ setupId: 'F', capsule: 'f'.repeat(40) })).resolves.toEqual(
      expected
    )
    expect(runnerCalls).toEqual([])
    await expect(s.capsuleCreate({ setupId: 'P' })).resolves.toEqual(expected)
    expect(runnerCalls.length).toBeGreaterThan(0)
  })

  it('answers not-found for an unknown setup and worktree-missing for a path that is gone, with no git', async () => {
    setups = [
      ...setups,
      setup({ id: 'G', hostId: 'local', path: join(root, 'gone'), createdAt: 3 })
    ]
    const s = service()
    await expect(s.capsuleCreate({ setupId: 'nope' })).resolves.toEqual({
      status: 'not-found',
      reason: 'unknown-setup'
    })
    await expect(s.capsuleList({ setupId: 'nope' })).resolves.toEqual({
      status: 'not-found',
      reason: 'unknown-setup'
    })
    await expect(s.capsuleRestore({ setupId: 'nope', capsule: 'f'.repeat(40) })).resolves.toEqual({
      status: 'not-found',
      reason: 'unknown-setup'
    })
    const missing = { status: 'refused', reason: 'worktree-missing' }
    await expect(s.capsuleCreate({ setupId: 'G' })).resolves.toEqual(missing)
    await expect(s.capsuleList({ setupId: 'G' })).resolves.toEqual(missing)
    await expect(s.capsuleRestore({ setupId: 'G', capsule: 'f'.repeat(40) })).resolves.toEqual(
      missing
    )
    expect(runnerCalls).toEqual([])
  })

  it('refuses a second operation on a busy worktree instead of queueing it; control: served after release', async () => {
    dirtyA()
    let release!: () => void
    let entered!: () => void
    const hold = new Promise<void>((r) => (release = r))
    const insideFirst = new Promise<void>((r) => (entered = r))
    let blocked = false
    const blocking: CapsuleGitRun = async (argv, options) => {
      if (!blocked) {
        blocked = true
        entered()
        await hold
      }
      return localCapsuleGit(argv, options)
    }
    const s = service(blocking)
    const first = s.capsuleCreate({ setupId: 'A' })
    await insideFirst
    const busy = { status: 'refused', reason: 'worktree-busy' }
    await expect(s.capsuleCreate({ setupId: 'A' })).resolves.toEqual(busy)
    await expect(s.capsuleRestore({ setupId: 'A', capsule: 'f'.repeat(40) })).resolves.toEqual(busy)
    // A different worktree is not blocked by it.
    await expect(s.capsuleCreate({ setupId: 'B' })).resolves.toEqual({
      status: 'ok',
      outcome: { kind: 'clean' }
    })
    release()
    expect(await first).toMatchObject({ status: 'ok' })
    expect(await s.capsuleCreate({ setupId: 'A' })).toMatchObject({
      status: 'ok',
      outcome: { alreadyExisted: true }
    })
  })
})

describe('capsuleList', () => {
  it('returns the capsules and the damaged entries exactly as listCapsules reports them', async () => {
    dirtyA()
    const s = service()
    const ref = await createdRef(s)
    // A ref that points at an ordinary commit is a damaged capsule, reported with its reason.
    git(
      a,
      'update-ref',
      `refs/orca/capsules/${git(a, 'rev-parse', 'HEAD')}`,
      git(a, 'rev-parse', 'HEAD')
    )
    const direct = await listCapsules(localCapsuleGit, a)
    const res = await s.capsuleList({ setupId: 'A' })
    expect(res).toEqual({ status: 'ok', capsules: direct })
    expect(direct.some((c) => 'damaged' in c && c.reason === 'not-a-capsule')).toBe(true)
    expect(direct.some((c) => c.ref === ref && !('damaged' in c))).toBe(true)
  })

  it('lists nothing for a worktree without capsules', async () => {
    await expect(service().capsuleList({ setupId: 'B' })).resolves.toEqual({
      status: 'ok',
      capsules: []
    })
  })
})

describe('capsuleRestore on a real clone', () => {
  it('plan leaves B byte-identical, apply makes B equal A, stash refs never move; restore onto dirty A is refused', async () => {
    dirtyA()
    plantStash(a)
    plantStash(b)
    const s = service()
    const stashBefore = [stashState(a), stashState(b)]
    const ref = await createdRef(s)
    carryToB(ref)
    const bBefore = { files: files(b), status: porcelain(b), head: git(b, 'rev-parse', 'HEAD') }

    const plan = await s.capsuleRestore({ setupId: 'B', capsule: ref })
    expect(plan).toMatchObject({
      status: 'ok',
      outcome: {
        kind: 'plan',
        ref,
        partial: false,
        changes: { tracked: 1, staged: 1, untracked: 1 }
      }
    })
    expect({ files: files(b), status: porcelain(b), head: git(b, 'rev-parse', 'HEAD') }).toEqual(
      bBefore
    )

    // Control for the refusal below: A itself is still dirty, so the same capsule cannot be applied there.
    const onDirty = await s.capsuleRestore({ setupId: 'A', capsule: ref, mode: 'apply' })
    expect(onDirty).toMatchObject({ status: 'refused', reason: 'worktree-not-clean' })
    expect(porcelain(a)).toContain('staged.txt')
    expect(readFileSync(join(a, 'tracked.txt'), 'utf8')).toBe('edited\n')

    const applied = await s.capsuleRestore({ setupId: 'B', capsule: ref, mode: 'apply' })
    expect(applied).toMatchObject({ status: 'ok', outcome: { kind: 'applied', ref } })
    expect(porcelain(b)).toBe(porcelain(a))
    expect(porcelain(b)).not.toBe('')
    expect(files(b)).toBe(files(a))
    expect([stashState(a), stashState(b)]).toEqual(stashBefore)
    expect(stashBefore[0]).not.toContain('absent|absent')
  })

  it('defaults to plan when mode is absent, and only mode apply changes the worktree', async () => {
    dirtyA()
    const s = service()
    const ref = await createdRef(s)
    carryToB(ref)
    const viaDefault = await s.capsuleRestore({ setupId: 'B', capsule: ref })
    expect(viaDefault).toMatchObject({ status: 'ok', outcome: { kind: 'plan' } })
    expect(porcelain(b)).toBe('')
    const viaPlan = await s.capsuleRestore({ setupId: 'B', capsule: ref, mode: 'plan' })
    expect(viaPlan).toMatchObject({ status: 'ok', outcome: { kind: 'plan' } })
    expect(porcelain(b)).toBe('')
    expect(await s.capsuleRestore({ setupId: 'B', capsule: ref, mode: 'apply' })).toMatchObject({
      status: 'ok',
      outcome: { kind: 'applied' }
    })
    expect(porcelain(b)).not.toBe('')
  })

  it('keeps every primitive refusal word and its detail', async () => {
    dirtyA()
    const s = service()
    const ref = await createdRef(s)
    await expect(s.capsuleRestore({ setupId: 'B', capsule: 'not-a-sha' })).resolves.toMatchObject({
      status: 'refused',
      reason: 'invalid-capsule-argument',
      detail: expect.stringContaining('full sha')
    })
    // The capsule exists only in A's repository, so B does not know it yet.
    await expect(s.capsuleRestore({ setupId: 'B', capsule: ref })).resolves.toMatchObject({
      status: 'refused',
      reason: 'capsule-unknown'
    })
    carryToB(ref)
    writeFileSync(join(b, 'unrelated.txt'), 'dirt\n')
    await expect(s.capsuleRestore({ setupId: 'B', capsule: ref })).resolves.toMatchObject({
      status: 'refused',
      reason: 'worktree-not-clean'
    })
    rmSync(join(b, 'unrelated.txt'))
    // Control: with the dirt gone the same request is served.
    await expect(s.capsuleRestore({ setupId: 'B', capsule: ref })).resolves.toMatchObject({
      status: 'ok'
    })
  })

  it('maps an apply failure to failed with the primitive recovery text, never to ok', async () => {
    dirtyA()
    const s = service()
    const ref = await createdRef(s)
    carryToB(ref)
    const breaking: CapsuleGitRun = (argv, options) =>
      argv[0] === 'checkout-index'
        ? Promise.reject(new Error('disk full'))
        : localCapsuleGit(argv, options)
    const res = await service(breaking).capsuleRestore({
      setupId: 'B',
      capsule: ref,
      mode: 'apply'
    })
    const sha = ref.slice('refs/orca/capsules/'.length)
    expect(res).toEqual({
      status: 'failed',
      reason: 'apply-failed',
      ref,
      detail: 'disk full',
      recovery: `Capsule ${ref} is intact; nothing was rolled back or deleted. Inspect git status in ${git(b, 'rev-parse', '--show-toplevel')}, and read any file from the capsule with git show ${sha}:<path> (untracked files are under ${sha}^3).`
    })
    // Control: the unbroken runner applies the same capsule.
    expect(await s.capsuleRestore({ setupId: 'B', capsule: ref, mode: 'apply' })).toMatchObject({
      status: 'ok',
      outcome: { kind: 'applied' }
    })
  })
})
