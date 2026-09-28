import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { captureRevisionSubject, hashPatch } from './review-subject-capture'

let repo = ''

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
}

function commit(file: string, content: string, message: string): string {
  writeFileSync(join(repo, file), content)
  git(['add', file])
  git(['commit', '-qm', message])
  return git(['rev-parse', 'HEAD'])
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'orca-review-subject-'))
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 'review@test.invalid'])
  git(['config', 'user.name', 'Review Test'])
  git(['config', 'commit.gpgsign', 'false'])
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('captureRevisionSubject', () => {
  it('binds a commit to the hash of exactly the patch it hands a reviewer', async () => {
    commit('a.txt', 'one\n', 'root')
    const sha = commit('a.txt', 'one\ntwo\n', 'add two')

    const captured = await captureRevisionSubject(repo)

    expect(captured).toMatchObject({ outcome: 'captured', subject: { revision: sha } })
    if (captured.outcome !== 'captured') {
      return
    }
    expect(captured.subject.patch).toContain('+two')
    expect(captured.subject.patchHash).toBe(hashPatch(captured.subject.patch))
  })

  it('fingerprints the same commit identically whatever the user has configured', async () => {
    commit('a.txt', 'one\n', 'root')
    commit('a.txt', 'one\ntwo\n', 'add two')
    const plain = await captureRevisionSubject(repo)

    git(['config', 'diff.noprefix', 'true'])
    git(['config', 'core.abbrev', '7'])
    git(['config', 'diff.renames', 'copies'])
    git(['config', 'diff.algorithm', 'histogram'])
    git(['config', 'color.ui', 'always'])
    const configured = await captureRevisionSubject(repo)

    expect(configured.outcome === 'captured' && configured.subject.patchHash).toBe(
      plain.outcome === 'captured' && plain.subject.patchHash
    )
  })

  it('gives a different fingerprint to different content', async () => {
    commit('a.txt', 'one\n', 'root')
    commit('a.txt', 'one\ntwo\n', 'add two')
    const first = await captureRevisionSubject(repo)
    commit('a.txt', 'one\ntwo\nthree\n', 'add three')

    const second = await captureRevisionSubject(repo)

    expect(first.outcome === 'captured' && second.outcome === 'captured').toBe(true)
    if (first.outcome === 'captured' && second.outcome === 'captured') {
      expect(second.subject.revision).not.toBe(first.subject.revision)
      expect(second.subject.patchHash).not.toBe(first.subject.patchHash)
    }
  })

  it('captures a root commit, and a named older revision rather than HEAD', async () => {
    const root = commit('a.txt', 'one\n', 'root')
    commit('a.txt', 'one\ntwo\n', 'add two')

    const captured = await captureRevisionSubject(repo, root)

    expect(captured).toMatchObject({ outcome: 'captured', subject: { revision: root } })
    expect(captured.outcome === 'captured' && captured.subject.patch).toContain('+one')
  })

  it('refuses a merge instead of reviewing it as an empty patch', async () => {
    const root = commit('a.txt', 'one\n', 'root')
    const tip = commit('a.txt', 'one\ntwo\n', 'add two')
    // Plumbing keeps the fixture to two calls; any commit with two parents is a merge.
    const merge = git(['commit-tree', `${tip}^{tree}`, '-p', tip, '-p', root, '-m', 'merge'])

    expect(await captureRevisionSubject(repo, merge)).toMatchObject({ outcome: 'unreadable', reason: 'merge-commit' })
  }, 90_000)

  it('refuses a revision that is not a commit', async () => {
    commit('a.txt', 'one\n', 'root')

    expect(await captureRevisionSubject(repo, 'no-such-ref')).toMatchObject({
      outcome: 'unreadable',
      reason: 'revision-not-found'
    })
  })
})
