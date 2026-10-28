import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decideReplicaAncestry } from './replica-bundle-receive'
import { divergenceRefs, preserveDivergence } from './replica-divergence'

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, env: ENV, encoding: 'utf8' }).trim()
let repo: string

function commitFile(name: string, body: string, msg: string): string {
  writeFileSync(join(repo, name), body)
  git(repo, 'add', name)
  git(repo, '-c', 'commit.gpgsign=false', 'commit', '-qm', msg)
  return git(repo, 'rev-parse', 'HEAD')
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'orca-div-'))
  git(repo, 'init', '-q', '-b', 'main')
  commitFile('f.txt', 'base\n', 'base')
})
afterEach(() => rmSync(repo, { recursive: true, force: true }))

async function diverge(conflicting: boolean): Promise<{ l: string; r: string; ancestry: Awaited<ReturnType<typeof decideReplicaAncestry>> }> {
  git(repo, 'checkout', '-q', '-b', 'other')
  const r2 = conflicting ? commitFile('f.txt', 'remote\n', 'remote side') : commitFile('r.txt', 'r\n', 'remote file')
  git(repo, 'checkout', '-q', 'main')
  const l = commitFile('f.txt', conflicting ? 'local\n' : 'base\nlocal\n', 'local side')
  return { l, r: r2, ancestry: await decideReplicaAncestry(repo, l, r2) }
}

describe('preserveDivergence', () => {
  it('preserves both tips as refs, surfaces the conflicted path, overwrites neither side', async () => {
    const { l, r, ancestry } = await diverge(true)
    if ('unknown' in ancestry) throw new Error('unknown')
    const res = await preserveDivergence({ repoPath: repo, hostKey: 'gex44', localTip: l, remoteTip: r, ancestry })
    expect(res).toMatchObject({ ok: true, conflict: { kind: 'conflicted', paths: ['f.txt'] }, alreadyPreserved: false })
    const refs = divergenceRefs('gex44', l, r)
    expect(git(repo, 'rev-parse', refs.local)).toBe(l)
    expect(git(repo, 'rev-parse', refs.remote)).toBe(r)
    expect(git(repo, 'rev-parse', 'main')).toBe(l)
    expect(git(repo, 'rev-parse', 'other')).toBe(r)
    expect(git(repo, 'status', '--porcelain')).toBe('')
    expect(readFileSync(join(repo, 'f.txt'), 'utf8')).toBe('local\n')
  })

  it('reports clean when the sides touch different files, and is idempotent', async () => {
    const { l, r, ancestry } = await diverge(false)
    if ('unknown' in ancestry) throw new Error('unknown')
    const a = await preserveDivergence({ repoPath: repo, hostKey: 'gex44', localTip: l, remoteTip: r, ancestry })
    expect(a).toMatchObject({ ok: true, conflict: { kind: 'clean' } })
    const b = await preserveDivergence({ repoPath: repo, hostKey: 'gex44', localTip: l, remoteTip: r, ancestry })
    expect(b).toMatchObject({ ok: true, alreadyPreserved: true })
  })

  it('refuses to move an occupied preservation ref', async () => {
    const { l, r, ancestry } = await diverge(true)
    if ('unknown' in ancestry) throw new Error('unknown')
    const refs = divergenceRefs('gex44', l, r)
    git(repo, 'update-ref', refs.local, r)
    const res = await preserveDivergence({ repoPath: repo, hostKey: 'gex44', localTip: l, remoteTip: r, ancestry })
    expect(res).toEqual({ ok: false, reason: 'ref-occupied' })
    expect(git(repo, 'rev-parse', refs.local)).toBe(r)
  })

  it('does nothing unless the ancestry is diverged, and rejects bad input', async () => {
    const tip = git(repo, 'rev-parse', 'HEAD')
    expect(await preserveDivergence({ repoPath: repo, hostKey: 'h', localTip: tip, remoteTip: tip, ancestry: { kind: 'same' } })).toEqual({ ok: false, reason: 'not-diverged' })
    const div = { kind: 'diverged', mergeBase: tip, aheadCount: 1, behindCount: 1 } as const
    expect(await preserveDivergence({ repoPath: repo, hostKey: '../x', localTip: tip, remoteTip: 'a'.repeat(40), ancestry: div })).toEqual({ ok: false, reason: 'bad-input' })
    expect(await preserveDivergence({ repoPath: repo, hostKey: 'h', localTip: tip, remoteTip: 'a'.repeat(40), ancestry: div })).toEqual({ ok: false, reason: 'tip-missing' })
    expect(git(repo, 'for-each-ref', 'refs/orca/divergence')).toBe('')
  })
})
