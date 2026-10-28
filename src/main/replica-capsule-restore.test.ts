import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCapsule, listCapsules, type CapsuleGitRun } from './replica-capsule'
import { localCapsuleGit } from './replica-capsule-git'
import { restoreCapsule, type CapsuleRestoreResult } from './replica-capsule-restore'

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t'
}
const raw = (cwd: string, ...a: string[]): string =>
  execFileSync('git', a, { cwd, env: ENV, encoding: 'utf8' })
const git = (cwd: string, ...a: string[]): string => raw(cwd, ...a).trim()

let root: string
let source: string
let target: string
let base: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-capsule-restore-'))
  source = join(root, 'source')
  git(root, 'init', '-q', '-b', 'main', source)
  writeFileSync(join(source, 'a.txt'), 'a\n')
  writeFileSync(join(source, 'keep.txt'), 'keep\n')
  mkdirSync(join(source, 'dir'))
  writeFileSync(join(source, 'dir', 'inner.txt'), 'inner\n')
  git(source, 'add', '.')
  git(source, 'commit', '-qm', 'seed')
  base = git(source, 'rev-parse', 'HEAD')
  target = join(root, 'target')
  git(root, 'clone', '-q', source, target)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

// Tracked edit (a.txt), staged new file (s.txt), untracked file (u.txt).
function dirtySource(): void {
  writeFileSync(join(source, 'a.txt'), 'dirty\n')
  writeFileSync(join(source, 's.txt'), 'staged\n')
  git(source, 'add', 's.txt')
  writeFileSync(join(source, 'u.txt'), 'untracked\n')
}

async function cut(repo = source): Promise<{ ref: string; sha: string }> {
  const made = await createCapsule(localCapsuleGit, repo)
  if (made.kind !== 'created') {
    throw new Error(`capsule not created: ${made.kind}`)
  }
  // Loose objects keep the object-missing fixture able to delete one file.
  git(
    target,
    '-c',
    'transfer.unpackLimit=100000',
    'fetch',
    '-q',
    '--no-tags',
    repo,
    `${made.ref}:${made.ref}`
  )
  return { ref: made.ref, sha: made.sha }
}

// A real refs/stash with a reflog in the target: restore must leave both byte-identical.
function plantStash(repo: string): void {
  const stash = git(repo, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'someone else wip')
  git(repo, 'update-ref', '--create-reflog', '-m', 'On main: someone else wip', 'refs/stash', stash)
}

function workingFiles(repo: string): string {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (name === '.git') {
        continue
      }
      const full = join(dir, name)
      const s = lstatSync(full)
      if (s.isDirectory()) {
        walk(full)
      } else {
        const digest = createHash('sha1').update(readFileSync(full)).digest('hex')
        out.push(`${full.slice(repo.length)}:${s.mode & 0o111 ? 'x' : '-'}:${digest}`)
      }
    }
  }
  walk(repo)
  return out.join('\n')
}

function headSha(repo: string): string | null {
  try {
    return git(repo, 'rev-parse', '--verify', '-q', 'HEAD')
  } catch {
    return null
  }
}

function snapshot(repo: string): Record<string, string> {
  const dotGit = join(repo, '.git')
  const stashLog = join(dotGit, 'logs', 'refs', 'stash')
  const sha = (path: string): string =>
    existsSync(path) ? createHash('sha1').update(readFileSync(path)).digest('hex') : 'absent'
  return {
    status: raw(repo, '--no-optional-locks', 'status', '--porcelain=v2', '-z', '-uall'),
    index: sha(join(dotGit, 'index')),
    head: git(repo, 'symbolic-ref', '-q', 'HEAD') + (headSha(repo) ?? 'unborn'),
    refs: git(repo, 'for-each-ref'),
    stashRef: git(repo, 'for-each-ref', '--format=%(objectname)', 'refs/stash'),
    stashLog: sha(stashLog),
    files: workingFiles(repo)
  }
}

const capsuleTrees = (repo: string, commit: string): string[] =>
  git(repo, 'rev-parse', `${commit}^{tree}`, `${commit}^2^{tree}`, `${commit}^3^{tree}`).split('\n')

function leftoverTemps(repo: string): string[] {
  return readdirSync(join(repo, '.git')).filter((n) => n.startsWith('orca-capsule-index-'))
}

const restore = (
  capsule: string,
  mode?: 'plan' | 'apply',
  runner: CapsuleGitRun = localCapsuleGit,
  worktreePath = target
): Promise<CapsuleRestoreResult> => restoreCapsule({ git: runner, worktreePath, capsule, mode })

describe('argument safety (T-02-25)', () => {
  const recorded = (): { runner: CapsuleGitRun; calls: string[][] } => {
    const calls: string[][] = []
    return {
      runner: (argv, opts) => {
        calls.push(argv)
        return localCapsuleGit(argv, opts)
      },
      calls
    }
  }

  it.each([
    ['a leading dash', '-h'],
    ['an option', '--upload-pack=touch /tmp/x'],
    ['a branch ref', 'refs/heads/main'],
    ['a parent traversal', '../../etc/passwd'],
    ['a revision expression', 'HEAD~1'],
    ['whitespace around a sha', ` ${'a'.repeat(40)} `],
    ['a trailing newline', `${'a'.repeat(40)}\n`],
    ['an empty string', ''],
    ['an abbreviated sha', 'abcdef1'],
    ['a prefix other than the capsule one', `refs/orca/other/${'a'.repeat(40)}`],
    ['uppercase hex', 'A'.repeat(40)]
  ])('refuses %s without running any git command', async (_label, arg) => {
    const { runner, calls } = recorded()
    const res = await restore(arg, 'apply', runner)
    expect(res).toMatchObject({ kind: 'refused', reason: 'invalid-capsule-argument' })
    expect(calls).toEqual([])
  })

  it('refuses an unknown mode without running any git command', async () => {
    const { runner, calls } = recorded()
    const res = await restore('a'.repeat(40), 'destroy' as 'plan', runner)
    expect(res).toMatchObject({ kind: 'refused', reason: 'invalid-mode' })
    expect(calls).toEqual([])
  })

  it('control: the bare sha and the exact capsule ref resolve the same capsule', async () => {
    dirtySource()
    const { ref, sha } = await cut()
    const bare = await restore(sha)
    const full = await restore(ref)
    expect(bare).toMatchObject({ kind: 'plan', sha, ref })
    expect(full).toEqual(bare)
  })
})

describe('plan mode (default) changes nothing', () => {
  it('reports the captured change counts and leaves status, index, HEAD, refs and the stash byte-identical', async () => {
    dirtySource()
    const { ref, sha } = await cut()
    plantStash(target)
    const before = snapshot(target)
    expect(before.stashLog).not.toBe('absent')
    expect(before.stashRef).toMatch(/^[0-9a-f]{40}$/)

    const res = await restore(sha)

    expect(res).toEqual({
      kind: 'plan',
      ref,
      sha,
      base,
      partial: false,
      changes: { tracked: 1, staged: 1, untracked: 1 }
    })
    expect(snapshot(target)).toEqual(before)
    expect(leftoverTemps(target)).toEqual([])
    expect(existsSync(join(target, 'u.txt'))).toBe(false)
  })

  it('an explicit plan mode equals the default', async () => {
    dirtySource()
    const { sha } = await cut()
    expect(await restore(sha, 'plan')).toEqual(await restore(sha))
  })
})

describe('apply mode', () => {
  it('reproduces tracked, staged and untracked state and proves it by re-capture', async () => {
    dirtySource()
    const { ref, sha } = await cut()
    plantStash(target)
    const stashBefore = snapshot(target)
    const sourceSnapshot = snapshot(source)

    const res = await restore(sha, 'apply')

    expect(res).toMatchObject({
      kind: 'applied',
      ref,
      sha,
      base,
      partial: false,
      changes: { tracked: 1, staged: 1, untracked: 1 },
      warnings: []
    })
    if (res.kind !== 'applied') {
      return
    }
    expect(res.recaptureRef).toBeUndefined()
    const after = snapshot(target)
    expect(after.status).toBe(sourceSnapshot.status)
    expect(after.files).toBe(sourceSnapshot.files)
    expect(after.head).toBe(stashBefore.head)
    expect(after.stashRef).toBe(stashBefore.stashRef)
    expect(after.stashLog).toBe(stashBefore.stashLog)
    expect(readFileSync(join(target, 'a.txt'), 'utf8')).toBe('dirty\n')
    expect(git(target, 'diff', '--cached', '--name-only')).toBe('s.txt')
    expect(git(target, 'diff', '--name-only')).toBe('a.txt')
    // An independent re-capture of the target has the capsule's own I, W and U trees.
    const again = await createCapsule(localCapsuleGit, target)
    expect(again.kind).toBe('created')
    if (again.kind === 'created') {
      expect(capsuleTrees(target, again.sha)).toEqual(capsuleTrees(target, sha))
    }
    expect(leftoverTemps(target)).toEqual([])
  })

  it('reproduces a tracked deletion, an executable bit and a new nested directory', async () => {
    unlinkSync(join(source, 'keep.txt'))
    chmodSync(join(source, 'dir', 'inner.txt'), 0o755)
    mkdirSync(join(source, 'new', 'deep'), { recursive: true })
    writeFileSync(join(source, 'new', 'deep', 'x.txt'), 'x\n')
    git(source, 'add', 'new')
    writeFileSync(join(source, 'new', 'deep', 'y.txt'), 'y\n')
    const { sha } = await cut()
    const sourceSnapshot = snapshot(source)

    const res = await restore(sha, 'apply')

    expect(res.kind).toBe('applied')
    const after = snapshot(target)
    expect(after.status).toBe(sourceSnapshot.status)
    expect(after.files).toBe(sourceSnapshot.files)
    expect(existsSync(join(target, 'keep.txt'))).toBe(false)
    expect(lstatSync(join(target, 'dir', 'inner.txt')).mode & 0o111).not.toBe(0)
  })

  it('a partial capsule applies without the omitted secret-shaped file and says so', async () => {
    dirtySource()
    writeFileSync(join(source, '.env'), 'TOKEN=secret\n')
    const { sha } = await cut()

    const res = await restore(sha, 'apply')

    expect(res).toMatchObject({ kind: 'applied', partial: true })
    expect(existsSync(join(target, '.env'))).toBe(false)
    expect(readFileSync(join(target, 'u.txt'), 'utf8')).toBe('untracked\n')
    if (res.kind === 'applied') {
      // The re-capture of a partial capsule is a different commit (no omission trailers), with equal trees.
      expect(res.recaptureRef).toMatch(/^refs\/orca\/capsules\//)
    }
  })

  it('a capsule cut on an unborn repository restores onto an unborn repository', async () => {
    const fresh = join(root, 'fresh')
    git(root, 'init', '-q', '-b', 'main', fresh)
    writeFileSync(join(fresh, 'staged.txt'), 'staged\n')
    git(fresh, 'add', 'staged.txt')
    writeFileSync(join(fresh, 'loose.txt'), 'loose\n')
    const empty = join(root, 'empty')
    git(root, 'init', '-q', '-b', 'main', empty)
    const made = await createCapsule(localCapsuleGit, fresh)
    if (made.kind !== 'created') {
      throw new Error(`capsule not created: ${made.kind}`)
    }
    git(
      empty,
      '-c',
      'transfer.unpackLimit=100000',
      'fetch',
      '-q',
      '--no-tags',
      fresh,
      `${made.ref}:${made.ref}`
    )

    const planned = await restore(made.sha, 'plan', localCapsuleGit, empty)
    expect(planned).toMatchObject({
      kind: 'plan',
      base: 'unborn',
      changes: { staged: 1, untracked: 1 }
    })
    const applied = await restore(made.sha, 'apply', localCapsuleGit, empty)
    expect(applied.kind).toBe('applied')
    expect(readFileSync(join(empty, 'staged.txt'), 'utf8')).toBe('staged\n')
    expect(readFileSync(join(empty, 'loose.txt'), 'utf8')).toBe('loose\n')
    expect(snapshot(empty).status).toBe(snapshot(fresh).status)

    // An unborn capsule never restores onto a repository that has a HEAD.
    git(
      target,
      '-c',
      'transfer.unpackLimit=100000',
      'fetch',
      '-q',
      '--no-tags',
      fresh,
      `${made.ref}:${made.ref}`
    )
    expect(await restore(made.sha)).toMatchObject({ kind: 'refused', reason: 'base-mismatch' })
  })
})

describe('refusals leave the worktree untouched, each with a control where the same fixture succeeds', () => {
  const refuseThenControl = async (
    sha: string,
    reason: string,
    fix: () => void,
    mode: 'plan' | 'apply' = 'apply'
  ): Promise<void> => {
    const before = snapshot(target)
    const res = await restore(sha, mode)
    expect(res).toMatchObject({ kind: 'refused', reason })
    expect(snapshot(target)).toEqual(before)
    expect(leftoverTemps(target)).toEqual([])
    fix()
    expect((await restore(sha, mode)).kind).toBe(mode === 'apply' ? 'applied' : 'plan')
  }

  it('capsule-unknown: the ref is absent, then present', async () => {
    dirtySource()
    const made = await createCapsule(localCapsuleGit, source)
    if (made.kind !== 'created') {
      throw new Error('no capsule')
    }
    await refuseThenControl(made.sha, 'capsule-unknown', () =>
      git(
        target,
        '-c',
        'transfer.unpackLimit=100000',
        'fetch',
        '-q',
        '--no-tags',
        source,
        `${made.ref}:${made.ref}`
      )
    )
  })

  describe('capsule-damaged agrees with listCapsules', () => {
    it('a commit under its own name that carries no capsule trailers', async () => {
      const plain = git(target, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'not a capsule')
      git(target, 'update-ref', `refs/orca/capsules/${plain}`, plain)
      expect(await listCapsules(localCapsuleGit, target)).toEqual([
        expect.objectContaining({
          ref: `refs/orca/capsules/${plain}`,
          damaged: true,
          reason: 'not-a-capsule'
        })
      ])
      expect(await restore(plain, 'apply')).toMatchObject({
        kind: 'refused',
        reason: 'capsule-damaged'
      })
    })

    it('a ref whose name is not its own target', async () => {
      dirtySource()
      const { sha } = await cut()
      const fake = 'b'.repeat(40)
      git(target, 'update-ref', `refs/orca/capsules/${fake}`, sha)
      const facts = await listCapsules(localCapsuleGit, target)
      expect(facts).toContainEqual(
        expect.objectContaining({ ref: `refs/orca/capsules/${fake}`, damaged: true })
      )
      expect(await restore(fake, 'apply')).toMatchObject({
        kind: 'refused',
        reason: 'capsule-damaged'
      })
    })

    it('an object the capsule needs is missing, and the healthy capsule is a control', async () => {
      dirtySource()
      const { sha } = await cut()
      const untrackedCommit = git(target, 'rev-parse', `${sha}^3`)
      const loose = join(
        target,
        '.git',
        'objects',
        untrackedCommit.slice(0, 2),
        untrackedCommit.slice(2)
      )
      expect(existsSync(loose)).toBe(true)
      expect(await listCapsules(localCapsuleGit, target)).toEqual([
        expect.objectContaining({ sha, baseTip: base })
      ])
      expect((await restore(sha, 'plan')).kind).toBe('plan')
      unlinkSync(loose)
      expect(await listCapsules(localCapsuleGit, target)).toEqual([
        expect.objectContaining({ damaged: true })
      ])
      const before = snapshot(target)
      expect(await restore(sha, 'apply')).toMatchObject({
        kind: 'refused',
        reason: 'capsule-damaged'
      })
      expect(snapshot(target)).toEqual(before)
    })
  })

  it('base-mismatch: HEAD moved off the capsule base, then returned', async () => {
    dirtySource()
    const { sha } = await cut()
    git(target, 'commit', '--allow-empty', '-qm', 'moved on')
    await refuseThenControl(sha, 'base-mismatch', () =>
      git(target, 'checkout', '-q', '--detach', base)
    )
  })

  it('worktree-not-clean: one modified tracked file, then reverted', async () => {
    dirtySource()
    const { sha } = await cut()
    writeFileSync(join(target, 'keep.txt'), 'my own work\n')
    await refuseThenControl(sha, 'worktree-not-clean', () =>
      git(target, 'checkout', '--', 'keep.txt')
    )
  })

  it('worktree-not-clean: an untracked file counts as dirty', async () => {
    dirtySource()
    const { sha } = await cut()
    writeFileSync(join(target, 'mine.txt'), 'x\n')
    await refuseThenControl(sha, 'worktree-not-clean', () => unlinkSync(join(target, 'mine.txt')))
  })

  it.each(['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD'])(
    'operation-in-progress: %s present, then removed',
    async (marker) => {
      dirtySource()
      const { sha } = await cut()
      const markerPath = join(target, '.git', marker)
      writeFileSync(markerPath, `${base}\n`)
      await refuseThenControl(sha, 'operation-in-progress', () => unlinkSync(markerPath))
    }
  )

  it.each(['rebase-merge', 'rebase-apply'])(
    'operation-in-progress: %s directory present, then removed',
    async (marker) => {
      dirtySource()
      const { sha } = await cut()
      const markerPath = join(target, '.git', marker)
      mkdirSync(markerPath)
      await refuseThenControl(sha, 'operation-in-progress', () =>
        rmSync(markerPath, { recursive: true })
      )
    }
  )

  it('not-a-git-repo: a plain directory, then the real worktree', async () => {
    dirtySource()
    const { sha } = await cut()
    const plain = mkdtempSync(join(tmpdir(), 'orca-capsule-plain-'))
    try {
      expect(await restore(sha, 'apply', localCapsuleGit, plain)).toMatchObject({
        kind: 'refused',
        reason: 'not-a-git-repo'
      })
      expect(readdirSync(plain)).toEqual([])
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
    expect((await restore(sha, 'apply')).kind).toBe('applied')
  })

  it('untracked-collision: an ignored file sits where an untracked file would be written', async () => {
    dirtySource()
    const { sha } = await cut()
    writeFileSync(join(target, '.git', 'info', 'exclude'), 'u.txt\n')
    writeFileSync(join(target, 'u.txt'), 'ignored but mine\n')
    await refuseThenControl(sha, 'untracked-collision', () => {
      unlinkSync(join(target, 'u.txt'))
      writeFileSync(join(target, '.git', 'info', 'exclude'), '')
    })
    expect(readFileSync(join(target, 'u.txt'), 'utf8')).toBe('untracked\n')
  })

  it('untracked-collision: an ignored file sits where a staged new file would be written', async () => {
    dirtySource()
    const { sha } = await cut()
    writeFileSync(join(target, '.git', 'info', 'exclude'), 's.txt\n')
    writeFileSync(join(target, 's.txt'), 'ignored but mine\n')
    await refuseThenControl(sha, 'untracked-collision', () => unlinkSync(join(target, 's.txt')))
  })

  it('untracked-collision: an ignored directory occupies the path of a new file', async () => {
    dirtySource()
    const { sha } = await cut()
    writeFileSync(join(target, '.git', 'info', 'exclude'), 's.txt/\n')
    mkdirSync(join(target, 's.txt'))
    writeFileSync(join(target, 's.txt', 'inside'), 'mine\n')
    await refuseThenControl(sha, 'untracked-collision', () =>
      rmSync(join(target, 's.txt'), { recursive: true })
    )
  })
})

describe('failure arms name the capsule and never roll back by deleting (T-02-28)', () => {
  it('a write that throws is apply-failed with recovery text, the capsule intact and no temp files left', async () => {
    dirtySource()
    const { ref, sha } = await cut()
    const diskFull: CapsuleGitRun = (argv, opts) =>
      argv.includes('checkout-index')
        ? Promise.reject(new Error('ENOSPC: no space left on device'))
        : localCapsuleGit(argv, opts)

    const res = await restore(sha, 'apply', diskFull)

    expect(res).toMatchObject({ kind: 'failed', reason: 'apply-failed', ref })
    if (res.kind !== 'failed') {
      return
    }
    expect(res.detail).toContain('ENOSPC')
    expect(res.recovery).toContain(ref)
    expect(res.recovery).toContain('intact')
    expect(res.recovery).toContain('nothing was rolled back or deleted')
    expect(git(target, 'rev-parse', ref)).toBe(sha)
    expect(leftoverTemps(target)).toEqual([])
  })

  it('a release that is a no-op leaves the index at the base and is verify-failed', async () => {
    dirtySource()
    const { ref, sha } = await cut()
    const noOpIndex: CapsuleGitRun = (argv, opts) =>
      argv[0] === 'read-tree' && !opts.env?.GIT_INDEX_FILE
        ? Promise.resolve('')
        : localCapsuleGit(argv, opts)

    const res = await restore(sha, 'apply', noOpIndex)

    expect(res).toMatchObject({ kind: 'failed', reason: 'verify-failed', ref })
    if (res.kind === 'failed') {
      expect(res.detail).toContain('index')
      expect(res.recovery).toContain(ref)
    }
    expect(git(target, 'rev-parse', ref)).toBe(sha)
  })

  it('control: the working runner applies the same fixture', async () => {
    dirtySource()
    const { sha } = await cut()
    expect((await restore(sha, 'apply')).kind).toBe('applied')
  })
})
