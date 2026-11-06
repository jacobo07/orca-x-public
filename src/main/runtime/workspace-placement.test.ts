import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readPlacement, readPlacements, type GitRead } from './workspace-placement'

const realGit: GitRead = async (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

function repo(remote: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-placement-'))
  const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  run('init', '-q', '-b', 'main')
  run('config', 'user.email', 'a@b.c')
  run('config', 'user.name', 'a')
  run('config', 'core.autocrlf', 'false')
  writeFileSync(join(dir, 'a.txt'), 'uno\n')
  run('add', 'a.txt')
  run('commit', '-q', '-m', 'first')
  if (remote) {
    run('remote', 'add', 'origin', remote)
  }
  return dir
}

describe('readPlacement', () => {
  const dirs: string[] = []
  const make = (remote: string | null = 'git@github.com:a/b.git'): string => {
    const dir = repo(remote)
    dirs.push(dir)
    return dir
  }
  const read = (path: string, id = 'r::x', instanceId: string | null = 'i1') =>
    readPlacement({ id, instanceId, path }, realGit)

  beforeEach(() => {
    dirs.length = 0
  })

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('gives two clones of one branch the same ref and keeps their paths apart', async () => {
    const one = await read(make(), 'r::one', 'i1')
    const two = await read(make('https://github.com/a/b'), 'r::two', 'i2')

    expect(one.workspaceRef).toBe(two.workspaceRef)
    expect(one.path).not.toBe(two.path)
    expect(one.repoKey).toBe('github.com/a/b')
  })

  it('separates branches', async () => {
    const dir = make()
    const main = await read(dir)
    execFileSync('git', ['checkout', '-q', '-b', 'fix'], { cwd: dir })

    expect((await read(dir)).workspaceRef).not.toBe(main.workspaceRef)
  })

  it('names a detached worktree by its instance', async () => {
    const dir = make()
    execFileSync('git', ['checkout', '-q', '--detach'], { cwd: dir })

    expect((await read(dir)).lineageKey).toBe('detached:i1')
  })

  it('uses the root commit when there is no remote', async () => {
    expect((await read(make(null))).repoKey).toMatch(/^root:[0-9a-f]{40}$/)
  })

  it('tells a dirty tracked file from a clean one with the same commit', async () => {
    const dir = make()
    const clean = await read(dir)
    appendFileSync(join(dir, 'a.txt'), 'dos\n')
    const dirty = await read(dir)

    expect(dirty.sourceRevision.baseCommit).toBe(clean.sourceRevision.baseCommit)
    expect(dirty.sourceRevision.trackedDiffFingerprint).not.toBe(
      clean.sourceRevision.trackedDiffFingerprint
    )
    expect(dirty.workspaceRef).toBe(clean.workspaceRef)
  })

  it('tells a new untracked file apart, and ignores what git ignores', async () => {
    const dir = make()
    writeFileSync(join(dir, '.gitignore'), 'ignorado.txt\n')
    const before = await read(dir)
    writeFileSync(join(dir, 'ignorado.txt'), 'x')
    const ignored = await read(dir)
    writeFileSync(join(dir, 'nuevo.txt'), 'x')
    const added = await read(dir)

    expect(ignored.sourceRevision.untrackedFingerprint).toBe(
      before.sourceRevision.untrackedFingerprint
    )
    expect(added.sourceRevision.untrackedFingerprint).not.toBe(
      before.sourceRevision.untrackedFingerprint
    )
  })

  it('never reads a remote worktree here, even when the same path exists on this machine', async () => {
    const local = make()
    const git = vi.fn(realGit)

    const result = await readPlacements(
      [{ id: 'ssh::w', instanceId: 'i', path: local, remote: true }],
      git
    )

    expect(git).not.toHaveBeenCalled()
    expect(result.placements).toEqual([])
    expect(result.unavailable).toEqual([
      expect.objectContaining({ worktreeId: 'ssh::w', unavailable: 'remote_repo_unsupported' })
    ])
  })

  it('keeps the identity of a worktree whose diff is too large to read', async () => {
    const dir = make()
    const git: GitRead = (args, cwd) =>
      args.includes('diff') ? Promise.reject(new Error('maxBuffer')) : realGit(args, cwd)

    const placement = await readPlacement({ id: 'r::x', instanceId: 'i', path: dir }, git)

    expect(placement.workspaceRef).toMatch(/^wsr_/)
    expect(placement.sourceRevision.trackedDiffFingerprint).toBeNull()
    expect(placement.sourceRevision.untrackedFingerprint).not.toBeNull()
  })

  it('reports what it did not reach before the deadline', async () => {
    const dir = make()
    let t = 0

    const result = await readPlacements(
      [
        { id: 'r::first', instanceId: 'i', path: dir },
        { id: 'r::second', instanceId: 'j', path: dir }
      ],
      async (args, cwd) => {
        t = 100
        return realGit(args, cwd)
      },
      50,
      () => t
    )

    expect(result.placements.map((p) => p.worktreeId)).toEqual(['r::first'])
    expect(result.unavailable).toEqual([
      expect.objectContaining({ worktreeId: 'r::second', unavailable: 'deadline_exceeded' })
    ])
  })

  it('is not changed by a user diff setting', async () => {
    const dir = make()
    appendFileSync(join(dir, 'a.txt'), 'dos\n')
    const before = await read(dir)
    execFileSync('git', ['config', 'diff.noprefix', 'true'], { cwd: dir })
    execFileSync('git', ['config', 'diff.context', '9'], { cwd: dir })

    expect((await read(dir)).sourceRevision.trackedDiffFingerprint).toBe(
      before.sourceRevision.trackedDiffFingerprint
    )
  })

  it('reports a worktree it cannot read instead of dropping it', async () => {
    const good = make()
    const missing = join(tmpdir(), 'orca-placement-no-such-dir')

    const result = await readPlacements(
      [
        { id: 'r::good', instanceId: 'i', path: good },
        { id: 'r::gone', instanceId: 'j', path: missing }
      ],
      realGit
    )

    expect(result.placements.map((p) => p.worktreeId)).toEqual(['r::good'])
    expect(result.unavailable).toEqual([
      expect.objectContaining({ worktreeId: 'r::gone', path: missing })
    ])
  })
})
