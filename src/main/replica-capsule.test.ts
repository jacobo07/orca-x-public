import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, utimesSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { createCapsule, listCapsules, type CapsuleGitRun } from './replica-capsule'
import { buildCapsuleMessage, isSecretShapedPath } from '../shared/replica-capsule-plan'

const SEED_ENV = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x.invalid', GIT_AUTHOR_DATE: '2026-10-01T00:00:00+0000',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x.invalid', GIT_COMMITTER_DATE: '2026-10-01T00:00:00+0000'
}
const run: CapsuleGitRun = (argv, { cwd, env, input }) =>
  new Promise((resolve, reject) => {
    const c = execFile('git', argv, { cwd, env: { ...process.env, ...env }, maxBuffer: 1 << 26 }, (e, out, err) =>
      e ? reject(new Error(`${e.message} ${err}`)) : resolve(out)
    )
    c.stdin?.on('error', () => {})
    c.stdin?.end(input ?? '')
  })
const g = (cwd: string, ...a: string[]): string =>
  execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...a], {
    cwd, encoding: 'utf8', env: { ...process.env, ...SEED_ENV }
  })

const dirs: string[] = []
function repo(): string {
  const d = mkdtempSync(join(tmpdir(), 'cap-'))
  dirs.push(d)
  g(d, 'init', '-q', '-b', 'main')
  writeFileSync(join(d, 'a.txt'), 'one\n')
  writeFileSync(join(d, 'b.txt'), 'bee\n')
  g(d, 'add', '.')
  g(d, 'commit', '-q', '-m', 'seed')
  return d
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

/** D-23: everything a capsule must not touch. */
function snapshot(d: string): string {
  const files = g(d, 'ls-files', '-o', '-m', '--exclude-standard').split('\n').sort().map((f) => (f && existsSync(join(d, f)) ? readFileSync(join(d, f), 'utf8') : '')).join('|')
  return [
    readFileSync(join(d, '.git/index')).toString('hex'),
    g(d, 'rev-parse', 'HEAD'),
    g(d, 'for-each-ref', 'refs/heads', 'refs/stash'),
    g(d, 'status', '--porcelain=v2', '-uall'),
    files
  ].join('\n')
}

describe('createCapsule', () => {
  it('clean tree -> clean, no ref', async () => {
    const d = repo()
    expect(await createCapsule(run, d)).toEqual({ kind: 'clean' })
    expect(g(d, 'for-each-ref', 'refs/orca')).toBe('')
  })

  it('captures staged, unstaged and untracked as a stash-shaped commit; user state is untouched', async () => {
    const d = repo()
    writeFileSync(join(d, 'a.txt'), 'staged\n')
    g(d, 'add', 'a.txt')
    writeFileSync(join(d, 'a.txt'), 'staged\nunstaged\n')
    writeFileSync(join(d, 'new.txt'), 'untracked\n')
    const before = snapshot(d)
    const r = await createCapsule(run, d)
    expect(snapshot(d)).toBe(before)
    if (r.kind !== 'created') throw new Error(JSON.stringify(r))
    expect(r.ref).toBe(`refs/orca/capsules/${r.sha}`)
    expect(g(d, 'rev-parse', r.ref).trim()).toBe(r.sha)
    const [, ...parents] = g(d, 'rev-list', '--parents', '-n', '1', r.sha).trim().split(' ')
    expect(parents).toHaveLength(3)
    expect(parents[0]).toBe(g(d, 'rev-parse', 'HEAD').trim())
    expect(g(d, 'show', `${r.sha}:a.txt`)).toBe('staged\nunstaged\n')
    expect(g(d, 'show', `${parents[1]}:a.txt`)).toBe('staged\n')
    expect(g(d, 'show', `${parents[2]}:new.txt`)).toBe('untracked\n')
    expect(r.partial).toBe(false)
    expect(readdirSync(join(d, '.git')).filter((n) => n.startsWith('orca-capsule-index-'))).toEqual([])
  })

  it('git stash apply restores the capsule on a fresh clone of HEAD', async () => {
    const d = repo()
    writeFileSync(join(d, 'a.txt'), 'staged\n')
    g(d, 'add', 'a.txt')
    writeFileSync(join(d, 'a.txt'), 'staged\nmore\n')
    writeFileSync(join(d, 'new.txt'), 'untracked\n')
    const r = await createCapsule(run, d)
    if (r.kind !== 'created') throw new Error('no capsule')
    const c = mkdtempSync(join(tmpdir(), 'cap-clone-'))
    dirs.push(c)
    g(c, 'clone', '-q', d, 'x')
    g(join(c, 'x'), 'fetch', '-q', d, r.ref)
    g(join(c, 'x'), 'stash', 'apply', '--index', r.sha)
    expect(readFileSync(join(c, 'x/a.txt'), 'utf8')).toBe('staged\nmore\n')
    expect(readFileSync(join(c, 'x/new.txt'), 'utf8')).toBe('untracked\n')
    expect(g(join(c, 'x'), 'show', ':a.txt')).toBe('staged\n')
  })

  it('is content addressed: same state twice -> one ref; another state -> another ref', async () => {
    const d = repo()
    writeFileSync(join(d, 'a.txt'), 'x\n')
    const r1 = await createCapsule(run, d)
    const r2 = await createCapsule(run, d)
    if (r1.kind !== 'created' || r2.kind !== 'created') throw new Error('no capsule')
    expect(r2.sha).toBe(r1.sha)
    expect(r1.alreadyExisted).toBe(false)
    expect(r2.alreadyExisted).toBe(true)
    writeFileSync(join(d, 'a.txt'), 'y\n')
    const r3 = await createCapsule(run, d)
    if (r3.kind !== 'created') throw new Error('no capsule')
    expect(r3.sha).not.toBe(r1.sha)
    expect(g(d, 'for-each-ref', 'refs/orca/capsules').trim().split('\n')).toHaveLength(2)
  })

  it('same dirty state in two separate clones gives the same W sha (cross-host property)', async () => {
    const a = repo()
    const b = mkdtempSync(join(tmpdir(), 'cap-b-'))
    dirs.push(b)
    g(b, 'clone', '-q', a, 'r')
    for (const p of [a, join(b, 'r')]) {
      writeFileSync(join(p, 'a.txt'), 'dirty\n')
      writeFileSync(join(p, 'u.txt'), 'u\n')
    }
    const ra = await createCapsule(run, a)
    const rb = await createCapsule(run, join(b, 'r'))
    if (ra.kind !== 'created' || rb.kind !== 'created') throw new Error('no capsule')
    expect(rb.sha).toBe(ra.sha)
  })

  it('omits and reports secret-shaped, nested-repo; capsule is PARTIAL; ignored files stay out', async () => {
    const d = repo()
    writeFileSync(join(d, '.gitignore'), 'ign.txt\n')
    g(d, 'add', '.gitignore')
    g(d, 'commit', '-q', '-m', 'ig')
    writeFileSync(join(d, 'ign.txt'), 'i')
    writeFileSync(join(d, '.env'), 'SECRET=1')
    mkdirSync(join(d, '.ssh'))
    writeFileSync(join(d, '.ssh/id_rsa'), 'k')
    writeFileSync(join(d, 'ok.txt'), 'ok')
    mkdirSync(join(d, 'nest'))
    g(join(d, 'nest'), 'init', '-q')
    writeFileSync(join(d, 'nest/f'), 'f')
    const r = await createCapsule(run, d)
    if (r.kind !== 'created') throw new Error('no capsule')
    expect(r.partial).toBe(true)
    expect(r.omissions.map((o) => `${o.reason}:${o.path}`).sort()).toEqual([
      'nested-repo:nest/', 'secret-shaped:.env', 'secret-shaped:.ssh/id_rsa'
    ])
    const u = g(d, 'rev-list', '--parents', '-n', '1', r.sha).trim().split(' ')[3]
    expect(g(d, 'ls-tree', '-r', '--name-only', u).trim()).toBe('ok.txt')
    expect(g(d, 'log', '-1', '--format=%B', r.sha)).toContain('Orca-Omitted-Path: secret-shaped:.env')
  })

  it('records deletions, modes and symlinks of tracked files', async () => {
    const d = repo()
    symlinkSync('a.txt', join(d, 'ln'))
    g(d, 'add', 'ln')
    g(d, 'commit', '-q', '-m', 'ln')
    execFileSync('rm', [join(d, 'b.txt')])
    execFileSync('chmod', ['+x', join(d, 'a.txt')])
    const r = await createCapsule(run, d)
    if (r.kind !== 'created') throw new Error('no capsule')
    expect(g(d, 'ls-tree', r.sha).includes('b.txt')).toBe(false)
    expect(g(d, 'ls-tree', r.sha)).toContain('100755 blob')
    expect(g(d, 'ls-tree', r.sha)).toContain('120000 blob')
  })

  it('unborn HEAD: root commits, Orca-Base unborn', async () => {
    const d = mkdtempSync(join(tmpdir(), 'cap-u-'))
    dirs.push(d)
    g(d, 'init', '-q', '-b', 'main')
    writeFileSync(join(d, 'f'), 'f')
    g(d, 'add', 'f')
    writeFileSync(join(d, 'g'), 'g')
    const r = await createCapsule(run, d)
    if (r.kind !== 'created') throw new Error(JSON.stringify(r))
    expect(r.base).toBe('unborn')
    expect(g(d, 'log', '-1', '--format=%B', r.sha)).toContain('Orca-Base: unborn')
    expect(g(d, 'show', `${r.sha}^1:f`)).toBe('f')
  })

  it('refuses unmerged state and in-progress merge; not-a-git-repo', async () => {
    const d = repo()
    g(d, 'checkout', '-q', '-b', 'x')
    writeFileSync(join(d, 'a.txt'), 'x\n'); g(d, 'commit', '-qam', 'x')
    g(d, 'checkout', '-q', 'main')
    writeFileSync(join(d, 'a.txt'), 'm\n'); g(d, 'commit', '-qam', 'm')
    expect(() => g(d, 'merge', 'x')).toThrow()
    const before = snapshot(d)
    expect(await createCapsule(run, d)).toEqual({ kind: 'refused', reason: 'capsule-unmerged' })
    expect(snapshot(d)).toBe(before)
    expect(g(d, 'for-each-ref', 'refs/orca')).toBe('')
    const plain = mkdtempSync(join(tmpdir(), 'cap-p-'))
    dirs.push(plain)
    expect(await createCapsule(run, plain)).toEqual({ kind: 'refused', reason: 'not-a-git-repo' })
  })

  it('capsule-unstable when the worktree changes between the two builds; no ref', async () => {
    const d = repo()
    writeFileSync(join(d, 'a.txt'), 'v1\n')
    let writeTrees = 0
    const racing: CapsuleGitRun = async (argv, o) => {
      const out = await run(argv, o)
      if (argv.includes('write-tree') && ++writeTrees === 2) writeFileSync(join(d, 'a.txt'), 'v2\n')
      return out
    }
    expect(await createCapsule(racing, d)).toEqual({ kind: 'refused', reason: 'capsule-unstable' })
    expect(g(d, 'for-each-ref', 'refs/orca')).toBe('')
  })

  it('crash drill: failing before any step leaves no ref, no temp files, user state identical', async () => {
    const d = repo()
    writeFileSync(join(d, 'a.txt'), 'dirty\n')
    writeFileSync(join(d, 'u.txt'), 'u\n')
    const before = snapshot(d)
    const steps = ['write-tree', 'add', 'update-index', 'commit-tree', 'update-ref']
    for (const step of steps) {
      const crashing: CapsuleGitRun = async (argv, o) => {
        if (argv.includes(step)) throw new Error(`crash at ${step}`)
        return run(argv, o)
      }
      await expect(createCapsule(crashing, d)).rejects.toThrow(`crash at ${step}`)
      expect(g(d, 'for-each-ref', 'refs/orca')).toBe('')
      expect(snapshot(d)).toBe(before)
      expect(readdirSync(join(d, '.git')).filter((n) => n.startsWith('orca-capsule-index-'))).toEqual([])
    }
    const ok = await createCapsule(run, d)
    expect(ok.kind).toBe('created')
  })

  it('sweeps stale temp index files of an earlier crashed run, only by own prefix', async () => {
    const d = repo()
    writeFileSync(join(d, 'a.txt'), 'dirty\n')
    const stale = join(d, '.git/orca-capsule-index-dead')
    const other = join(d, '.git/orca-other')
    writeFileSync(stale, 'x'); writeFileSync(other, 'x')
    const old = new Date(Date.now() - 60_000)
    utimesSync(stale, old, old); utimesSync(other, old, old)
    await createCapsule(run, d)
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(other)).toBe(true)
  })
})

describe('listCapsules', () => {
  it('lists complete capsules and classifies a damaged one, never as absent', async () => {
    const d = repo()
    writeFileSync(join(d, 'a.txt'), 'dirty\n')
    const r = await createCapsule(run, d)
    if (r.kind !== 'created') throw new Error('no capsule')
    expect(await listCapsules(run, d)).toEqual([{ ref: r.ref, sha: r.sha, baseTip: r.base, partial: false }])
    const bogus = 'f'.repeat(40)
    execFileSync('git', ['update-ref', '--no-deref', `refs/orca/capsules/${bogus}`, g(d, 'rev-parse', 'HEAD').trim()], { cwd: d })
    const facts = await listCapsules(run, d)
    expect(facts.some((f) => 'damaged' in f && f.ref.endsWith(bogus))).toBe(true)
    expect(facts).toHaveLength(2)
  })

  it('empty repo -> []', async () => {
    expect(await listCapsules(run, repo())).toEqual([])
  })
})

describe('plan helpers', () => {
  it('denylist', () => {
    for (const p of ['.env', 'a/.env.local', 'k.pem', 'x/id_rsa.pub', '.aws/credentials', 'credentials-x.json', '.npmrc'])
      expect(isSecretShapedPath(p)).toBe(true)
    for (const p of ['env.ts', 'src/key.ts', 'readme.md']) expect(isSecretShapedPath(p)).toBe(false)
  })
  it('caps omission lines at 200 with a truncation trailer', () => {
    const om = Array.from({ length: 205 }, (_, i) => ({ reason: 'secret-shaped' as const, path: `p${i}` }))
    const m = buildCapsuleMessage({ base: 'b', branch: 'main', omissions: om })
    expect(m.match(/Orca-Omitted-Path:/g)).toHaveLength(200)
    expect(m).toContain('Orca-Omitted-Truncated: 5')
    expect(m).toContain('Orca-Omitted: 205')
  })
})
