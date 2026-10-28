import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseMergeTreeOutput, reconcileDirtyBoth } from './replica-reconcile'
import { createCapsule } from './replica-capsule'
import { localCapsuleGit } from './replica-capsule-git'

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, env: ENV, encoding: 'utf8' }).trim()

let root: string
let a: string
let b: string
let base: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-reconcile-'))
  a = join(root, 'a')
  git(root, 'init', '-q', '-b', 'main', a)
  writeFileSync(join(a, 'one.txt'), 'l1\nl2\nl3\n')
  writeFileSync(join(a, 'two.txt'), 'x\ny\nz\n')
  writeFileSync(join(a, 'three.txt'), 'p\nq\n')
  git(a, 'add', '.')
  git(a, 'commit', '-qm', 'seed')
  base = git(a, 'rev-parse', 'HEAD')
  b = join(root, 'b')
  git(root, 'clone', '-q', a, b)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

// Brings B's capsule into A's object store, as the transfer step would.
async function cut(editA: () => void, editB: () => void): Promise<{ la: string; rb: string }> {
  editA()
  editB()
  const ca = await createCapsule(localCapsuleGit, a)
  const cb = await createCapsule(localCapsuleGit, b)
  if (ca.kind !== 'created' || cb.kind !== 'created') {
    throw new Error(`capsule not created: ${ca.kind} ${cb.kind}`)
  }
  git(a, 'fetch', '-q', b, cb.ref)
  return { la: ca.sha, rb: cb.sha }
}

describe('reconcileDirtyBoth', () => {
  it('reconciles same-base disjoint edits (different files and different hunks of one file)', async () => {
    const { la, rb } = await cut(
      () => {
        writeFileSync(join(a, 'one.txt'), 'L1\nl2\nl3\n')
        writeFileSync(join(a, 'three.txt'), 'P\nq\n')
      },
      () => {
        writeFileSync(join(b, 'one.txt'), 'l1\nl2\nL3\n')
        writeFileSync(join(b, 'two.txt'), 'x\nY\nz\n')
      }
    )
    const headBefore = git(a, 'rev-parse', 'HEAD')
    const res = await reconcileDirtyBoth({ repoPath: a, localCapsule: la, remoteCapsule: rb, base })
    expect(res.ok).toBe(true)
    if (!res.ok) {
      return
    }
    expect(git(a, 'show', `${res.commit}:one.txt`)).toBe('L1\nl2\nL3')
    expect(git(a, 'show', `${res.commit}:two.txt`)).toBe('x\nY\nz')
    expect(git(a, 'show', `${res.commit}:three.txt`)).toBe('P\nq')
    expect(res.untrackedNotReconciled).toBe(false)
    expect(git(a, 'rev-list', '--parents', '-n', '1', res.commit).split(' ').slice(1)).toEqual([la, rb])
    expect(git(a, 'rev-parse', res.ref)).toBe(res.commit)
    expect(git(a, 'rev-parse', 'HEAD')).toBe(headBefore)
  })

  it('same-line edits are a conflict naming the path, and write no ref', async () => {
    const { la, rb } = await cut(
      () => writeFileSync(join(a, 'one.txt'), 'A\nl2\nl3\n'),
      () => writeFileSync(join(b, 'one.txt'), 'B\nl2\nl3\n')
    )
    const res = await reconcileDirtyBoth({ repoPath: a, localCapsule: la, remoteCapsule: rb, base })
    expect(res).toEqual({ ok: false, reason: 'conflict', base, conflictedPaths: ['one.txt'] })
    expect(git(a, 'for-each-ref', 'refs/orca/reconciled')).toBe('')
  })

  it('flags untracked content and never merges it into the reconciled tree', async () => {
    const { la, rb } = await cut(
      () => writeFileSync(join(a, 'one.txt'), 'L1\nl2\nl3\n'),
      () => {
        writeFileSync(join(b, 'two.txt'), 'x\nY\nz\n')
        writeFileSync(join(b, 'only-untracked-b.txt'), 'u\n')
      }
    )
    expect(git(a, 'rev-list', '--parents', '-n', '1', rb).split(' ')).toHaveLength(4)
    const res = await reconcileDirtyBoth({ repoPath: a, localCapsule: la, remoteCapsule: rb, base })
    expect(res.ok).toBe(true)
    if (!res.ok) {
      return
    }
    expect(res.untrackedNotReconciled).toBe(true)
    expect(git(a, 'show', `${res.commit}:two.txt`)).toBe('x\nY\nz')
    expect(() => git(a, 'cat-file', '-e', `${res.commit}:only-untracked-b.txt`)).toThrow()
  })

  it('flags untracked content on the local capsule too', async () => {
    const { la, rb } = await cut(
      () => writeFileSync(join(a, 'only-untracked-a.txt'), 'u\n'),
      () => writeFileSync(join(b, 'two.txt'), 'x\nY\nz\n')
    )
    const res = await reconcileDirtyBoth({ repoPath: a, localCapsule: la, remoteCapsule: rb, base })
    expect(res).toMatchObject({ ok: true, untrackedNotReconciled: true })
  })

  it('refuses a capsule whose FIRST parent is not the base even when the base is a later parent', async () => {
    const { la, rb } = await cut(
      () => writeFileSync(join(a, 'one.txt'), 'L1\nl2\nl3\n'),
      () => writeFileSync(join(b, 'two.txt'), 'x\nY\nz\n')
    )
    const stranger = git(a, 'commit-tree', `${base}^{tree}`, '-m', 'stranger')
    const disguised = git(a, 'commit-tree', `${rb}^{tree}`, '-p', stranger, '-p', base, '-m', 'disguised')
    expect(await reconcileDirtyBoth({ repoPath: a, localCapsule: la, remoteCapsule: disguised, base })).toEqual({
      ok: false,
      reason: 'not-same-base'
    })
  })

  it('refuses capsules not cut from the stated base', async () => {
    const { la, rb } = await cut(
      () => writeFileSync(join(a, 'one.txt'), 'A\nl2\nl3\n'),
      () => writeFileSync(join(b, 'two.txt'), 'x\nY\nz\n')
    )
    const other = git(a, 'commit-tree', `${base}^{tree}`, '-m', 'other')
    expect(await reconcileDirtyBoth({ repoPath: a, localCapsule: la, remoteCapsule: rb, base: other })).toEqual({ ok: false, reason: 'not-same-base' })
    expect(await reconcileDirtyBoth({ repoPath: a, localCapsule: la, remoteCapsule: la.replace(/./, (c) => (c === '0' ? '1' : '0')), base })).toEqual({ ok: false, reason: 'unknown-commit' })
  })

  it('refuses bad input and a merge-tree that is unsupported', async () => {
    expect(await reconcileDirtyBoth({ repoPath: a, localCapsule: 'x', remoteCapsule: 'y', base })).toEqual({ ok: false, reason: 'invalid-input' })
    const { la, rb } = await cut(
      () => writeFileSync(join(a, 'one.txt'), 'A\nl2\nl3\n'),
      () => writeFileSync(join(b, 'two.txt'), 'x\nY\nz\n')
    )
    const real = (await import('./git/runner')).gitExecFileAsync
    const res = await reconcileDirtyBoth({
      repoPath: a, localCapsule: la, remoteCapsule: rb, base,
      git: (argv, opts) => (argv[0] === 'merge-tree' ? Promise.reject(new Error('unknown option: write-tree')) : real(argv, opts))
    })
    expect(res).toEqual({ ok: false, reason: 'merge-tree-unsupported' })
  })
})

describe('parseMergeTreeOutput', () => {
  it('takes the tree line and de-duplicated conflicted paths up to the blank line', () => {
    expect(parseMergeTreeOutput('abc\nb.txt\na.txt\nb.txt\n\nAuto-merging x\n')).toEqual({ tree: 'abc', conflictedPaths: ['a.txt', 'b.txt'] })
  })
})
