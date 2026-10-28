import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decideReplicaAncestry, receiveReplicaBundle } from './replica-bundle-receive'
import type { gitExecFileAsync } from './git/runner'

// Pass-through runner; a test sets fetchFailure to make only `git fetch` reject.
const runner = vi.hoisted(() => ({ fetchFailure: null as unknown }))
vi.mock('./git/runner', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown> & { gitExecFileAsync: typeof gitExecFileAsync }>()
  return {
    ...real,
    gitExecFileAsync: (argv: string[], options: Parameters<typeof gitExecFileAsync>[1]) =>
      argv[0] === 'fetch' && runner.fetchFailure
        ? Promise.reject(runner.fetchFailure)
        : real.gitExecFileAsync(argv, options)
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
const commit = (cwd: string, msg: string): string => {
  git(cwd, 'commit', '--allow-empty', '-m', msg)
  return git(cwd, 'rev-parse', 'HEAD')
}

let root: string
let a: string
let b: string
beforeEach(() => {
  runner.fetchFailure = null
  root = mkdtempSync(join(tmpdir(), 'x06-'))
  a = join(root, 'a')
  b = join(root, 'b')
  git(root, 'init', '-q', '-b', 'main', a)
  commit(a, 'base')
  git(root, 'clone', '-q', a, b)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function bundleOf(repo: string, name: string): { path: string; heads: { ref: string; sha: string }[] } {
  const path = join(root, name)
  git(repo, 'bundle', 'create', path, 'main')
  const heads = git(repo, 'bundle', 'list-heads', path)
    .split('\n')
    .map((l) => ({ sha: l.split(' ')[0], ref: l.split(' ')[1] }))
  return { path, heads }
}
const replicaRefs = (repo: string): string =>
  git(repo, 'for-each-ref', 'refs/orca/replicas')

describe('receiveReplicaBundle + decideReplicaAncestry', () => {
  it('fetches a verified bundle and decides ahead / behind / diverged on its objects', async () => {
    const tipA = git(a, 'rev-parse', 'HEAD')
    const tipB = commit(b, 'b1')
    commit(b, 'b2')
    const bTip = git(b, 'rev-parse', 'HEAD')
    const bun = bundleOf(b, 'b.bundle')
    const r = await receiveReplicaBundle({ repoPath: a, bundlePath: bun.path, declaredHeads: bun.heads, hostKey: 'hostb' })
    expect(r.ok).toBe(true)
    expect(existsSync(bun.path)).toBe(false)
    expect(await decideReplicaAncestry(a, tipA, bTip)).toEqual({ kind: 'behind', count: 2 })
    expect(await decideReplicaAncestry(a, bTip, tipA)).toEqual({ kind: 'ahead', count: 2 })
    commit(a, 'a1')
    const divergedA = git(a, 'rev-parse', 'HEAD')
    expect(await decideReplicaAncestry(a, divergedA, bTip)).toMatchObject({
      kind: 'diverged',
      mergeBase: tipA,
      aheadCount: 1,
      behindCount: 2
    })
    expect(tipB).not.toBe(bTip)
  })

  it('equal tips are same; unrelated roots are unrelated', async () => {
    const tip = git(a, 'rev-parse', 'HEAD')
    expect(await decideReplicaAncestry(a, tip, tip)).toEqual({ kind: 'same' })
    git(b, 'checkout', '-q', '--orphan', 'other')
    const root2 = commit(b, 'root2')
    const path = join(root, 'o.bundle')
    git(b, 'bundle', 'create', path, 'other')
    const r = await receiveReplicaBundle({
      repoPath: a,
      bundlePath: path,
      declaredHeads: [{ ref: 'refs/heads/other', sha: root2 }],
      hostKey: 'k'
    })
    expect(r.ok).toBe(true)
    expect(await decideReplicaAncestry(a, tip, root2)).toEqual({ kind: 'unrelated' })
  })

  it('a corrupted bundle is refused, deleted, and writes no ref', async () => {
    commit(b, 'b1')
    const bun = bundleOf(b, 'c.bundle')
    const buf = execFileSync('cat', [bun.path])
    buf[buf.length - 20] ^= 0xff
    writeFileSync(bun.path, buf)
    const r = await receiveReplicaBundle({ repoPath: a, bundlePath: bun.path, declaredHeads: bun.heads, hostKey: 'k' })
    // Pack-trailer damage can pass `bundle verify` and then fail in fetch; either way no ref lands.
    expect(r.ok).toBe(false)
    expect(existsSync(bun.path)).toBe(false)
    expect(replicaRefs(a)).toBe('')
  })

  it('heads that differ from the declared set are refused before fetch', async () => {
    commit(b, 'b1')
    const bun = bundleOf(b, 'd.bundle')
    const r = await receiveReplicaBundle({
      repoPath: a,
      bundlePath: bun.path,
      declaredHeads: [{ ref: bun.heads[0].ref, sha: 'f'.repeat(40) }],
      hostKey: 'k'
    })
    expect(r).toEqual({ ok: false, reason: 'bundle-heads-mismatch' })
    expect(replicaRefs(a)).toBe('')
    expect(existsSync(bun.path)).toBe(false)
  })

  it('a bundle with a missing prerequisite fails verify', async () => {
    commit(b, 'b1')
    const first = git(b, 'rev-parse', 'HEAD')
    commit(b, 'b2')
    const path = join(root, 'p.bundle')
    git(b, 'bundle', 'create', path, `${first}..main`)
    const heads = git(b, 'bundle', 'list-heads', path).split('\n').map((l) => ({ sha: l.split(' ')[0], ref: l.split(' ')[1] }))
    const r = await receiveReplicaBundle({ repoPath: a, bundlePath: path, declaredHeads: heads, hostKey: 'k' })
    expect(r).toEqual({ ok: false, reason: 'bundle-verify-failed' })
  })

  it('refuses unsafe host keys and relative bundle paths', async () => {
    const heads = [{ ref: 'refs/heads/main', sha: 'a'.repeat(40) }]
    expect((await receiveReplicaBundle({ repoPath: a, bundlePath: '/nope', declaredHeads: heads, hostKey: '../x' })).ok).toBe(false)
    expect((await receiveReplicaBundle({ repoPath: a, bundlePath: 'rel', declaredHeads: heads, hostKey: 'k' })).ok).toBe(false)
  })

  it('an unknown tip object reads bundle-verify-failed, not an ancestry', async () => {
    const tip = git(a, 'rev-parse', 'HEAD')
    expect(await decideReplicaAncestry(a, tip, 'e'.repeat(40))).toEqual({ unknown: 'bundle-verify-failed' })
  })

  describe('the fetch failure cause (row 65)', () => {
    const run = async (): Promise<{ r: Awaited<ReturnType<typeof receiveReplicaBundle>>; path: string }> => {
      commit(b, 'b1')
      const bun = bundleOf(b, 'f.bundle')
      const r = await receiveReplicaBundle({ repoPath: a, bundlePath: bun.path, declaredHeads: bun.heads, hostKey: 'k' })
      return { r, path: bun.path }
    }

    it('a fetch that rejects with ENOSPC is transfer-interrupted with cause disk-full, leaving nothing', async () => {
      runner.fetchFailure = Object.assign(new Error('Command failed'), { code: 'ENOSPC' })
      const { r, path } = await run()
      expect(r).toEqual({ ok: false, reason: 'transfer-interrupted', cause: 'disk-full' })
      expect(existsSync(path)).toBe(false)
      expect(replicaRefs(a)).toBe('')
    })

    it('git wording in stderr is also disk-full', async () => {
      runner.fetchFailure = Object.assign(new Error('Command failed'), { stderr: 'fatal: No space left on device' })
      const { r } = await run()
      expect(r).toEqual({ ok: false, reason: 'transfer-interrupted', cause: 'disk-full' })
    })

    it('control: a fetch that rejects with ECONNRESET has no cause key', async () => {
      runner.fetchFailure = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
      const { r, path } = await run()
      expect(r).toEqual({ ok: false, reason: 'transfer-interrupted' })
      expect('cause' in r).toBe(false)
      expect(existsSync(path)).toBe(false)
      expect(replicaRefs(a)).toBe('')
    })

    it('control: with no failure the same input is received', async () => {
      const { r } = await run()
      expect(r.ok).toBe(true)
    })

    it('verify and heads-mismatch results carry no cause key even when the runner would say ENOSPC', async () => {
      runner.fetchFailure = Object.assign(new Error('x'), { code: 'ENOSPC' })
      commit(b, 'b1')
      const bun = bundleOf(b, 'g.bundle')
      const mismatch = await receiveReplicaBundle({
        repoPath: a,
        bundlePath: bun.path,
        declaredHeads: [{ ref: bun.heads[0].ref, sha: 'f'.repeat(40) }],
        hostKey: 'k'
      })
      expect(mismatch).toEqual({ ok: false, reason: 'bundle-heads-mismatch' })
      expect('cause' in mismatch).toBe(false)
      const unverifiable = await receiveReplicaBundle({
        repoPath: a,
        bundlePath: join(root, 'missing.bundle'),
        declaredHeads: bun.heads,
        hostKey: 'k'
      })
      expect(unverifiable).toEqual({ ok: false, reason: 'bundle-verify-failed' })
    })
  })
})
