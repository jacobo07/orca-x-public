// WR-01: sync must not fast-forward HEAD while the anchor worktree is mid rebase/merge/cherry-pick/revert/bisect,
// including the clean-tree case where the capsule short-circuits before it looks at the markers.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fastForwardToDescendant } from './replica-sync'

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
const gitPath = (cwd: string, name: string): string =>
  join(cwd, git(cwd, 'rev-parse', '--git-path', name))

let root: string
let repo: string
let c3: string

// Three commits; an interactive rebase stopped at `edit` on the second leaves a clean tree, detached HEAD, and the third
// commit as a descendant of HEAD.
function stopRebaseAtEdit(cwd: string): string {
  execFileSync('git', ['rebase', '-i', 'HEAD~2'], {
    cwd,
    env: { ...ENV, GIT_SEQUENCE_EDITOR: "sed -i '1s/^pick/edit/'" },
    stdio: 'ignore'
  })
  return git(cwd, 'rev-parse', 'HEAD')
}
const ff = (cwd: string, head: string, target: string) =>
  fastForwardToDescendant({
    repoPath: cwd,
    expectedLocalTip: head,
    targetTip: target,
    evidenceGeneration: 1,
    currentGeneration: () => 1
  })
const capsuleRefs = (cwd: string): string =>
  git(cwd, 'for-each-ref', '--format=%(refname)', 'refs/orca/capsules')

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wr01-'))
  repo = join(root, 'repo')
  git(root, 'init', '-q', '-b', 'main', repo)
  commitFile(repo, 'a.txt', 'a\n')
  commitFile(repo, 'b.txt', 'b\n')
  c3 = commitFile(repo, 'c.txt', 'c\n')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('operation-in-progress guard (WR-01)', () => {
  it('a rebase stopped at edit with a clean tree refuses and leaves HEAD byte-identical', async () => {
    const head = stopRebaseAtEdit(repo)
    expect(git(repo, 'status', '--porcelain')).toBe('')
    expect(existsSync(gitPath(repo, 'rebase-merge'))).toBe(true)

    expect(await ff(repo, head, c3)).toEqual({ ok: false, reason: 'operation-in-progress' })

    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head)
    expect(capsuleRefs(repo)).toBe('')
    // The rebase is still resumable, which a moved HEAD breaks.
    git(repo, 'rebase', '--continue')
    expect(git(repo, 'rev-parse', 'main')).toBe(c3)
  })

  it('the same stopped rebase in a linked worktree refuses (markers resolved through git-path)', async () => {
    const linked = join(root, 'linked')
    git(repo, 'worktree', 'add', '-q', '-b', 'side', linked)
    const head = stopRebaseAtEdit(linked)
    expect(existsSync(join(linked, '.git'))).toBe(true)
    // The marker lives in the per-worktree git dir, not at <repo>/.git/rebase-merge.
    expect(existsSync(join(repo, '.git', 'rebase-merge'))).toBe(false)

    expect(await ff(linked, head, c3)).toEqual({ ok: false, reason: 'operation-in-progress' })
    expect(git(linked, 'rev-parse', 'HEAD')).toBe(head)
  })

  it.each([
    'rebase-merge',
    'rebase-apply',
    'REBASE_HEAD',
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'BISECT_LOG'
  ])('a %s marker on a clean tree refuses', async (marker) => {
    git(repo, 'reset', '-q', '--hard', 'HEAD~1')
    const head = git(repo, 'rev-parse', 'HEAD')
    const path = gitPath(repo, marker)
    if (marker.startsWith('rebase-')) {
      execFileSync('mkdir', ['-p', path])
    } else {
      writeFileSync(path, `${head}\n`)
    }
    expect(await ff(repo, head, c3)).toEqual({ ok: false, reason: 'operation-in-progress' })
  })

  it('control: no marker and a clean tree fast-forwards', async () => {
    git(repo, 'reset', '-q', '--hard', 'HEAD~1')
    const head = git(repo, 'rev-parse', 'HEAD')
    expect(await ff(repo, head, c3)).toMatchObject({ ok: true, to: c3 })
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(c3)
  })

  it('control: a marker in the main git dir does not block a linked worktree that has none', async () => {
    const linked = join(root, 'linked')
    git(repo, 'worktree', 'add', '-q', '-b', 'side', linked, 'HEAD~1')
    writeFileSync(join(repo, '.git', 'MERGE_HEAD'), `${c3}\n`)
    const head = git(linked, 'rev-parse', 'HEAD')
    expect(await ff(linked, head, c3)).toMatchObject({ ok: true, to: c3 })
  })
})
