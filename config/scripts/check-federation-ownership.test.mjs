import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BASE,
  DEFAULT_HEAD,
  SUBSYSTEM_PREFIXES,
  createGitRunner,
  deriveFederationOwnedPaths,
  judgeIntersection,
  listChangedPaths,
  runOwnershipSweep
} from './check-federation-ownership.mjs'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const SCRIPT = path.join(REPO_ROOT, 'config', 'scripts', 'check-federation-ownership.mjs')
const GIT_DIR = 'C:\\Program Files\\Git\\cmd'
const REAL_TIMEOUT = 120_000

// Why probe: the real-git cases measure DEFAULT_HEAD, a ref only the checkout that integrated federation holds.
// A host without it must report those cases as skipped, naming the ref, instead of failing on a git error.
function headResolves(runGit, head) {
  try {
    runGit(['rev-parse', '--verify', '--quiet', `${head}^{commit}`])
    return true
  } catch {
    return false
  }
}
const FEDERATION_HEAD_PRESENT = headResolves(
  createGitRunner(process.env.GIT_EXE || 'git', REPO_ROOT),
  DEFAULT_HEAD
)
const realIt = FEDERATION_HEAD_PRESENT ? it : it.skip
const needsHead = (title) =>
  FEDERATION_HEAD_PRESENT ? title : `${title} [SKIPPED: ref ${DEFAULT_HEAD} is absent on this host]`

function spawnSweep(args) {
  const env = {
    ...process.env,
    Path: `${GIT_DIR};${process.env.Path || ''}`,
    PATH: `${GIT_DIR};${process.env.PATH || ''}`
  }
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8'
  })
  return { status: r.status, stdout: r.stdout || '' }
}

function controlFile(name, paths) {
  const dir = mkdtempSync(path.join(tmpdir(), `p7-${name}-${process.pid}-`))
  const file = path.join(dir, 'changed.txt')
  writeFileSync(file, `${paths.join('\n')}\n`)
  return file
}

const REASON = 'shared registry touch, not a federation subsystem edit'
const entry = (p, commits = ['abc1234'], reason = REASON) => ({ path: p, commits, reason })

describe('judgeIntersection', () => {
  it('Test 1: an allow-listed touch with every sha listed is ALLOWED', () => {
    const r = judgeIntersection({
      owned: ['a.ts'],
      changed: ['a.ts'],
      allowList: [entry('a.ts')],
      touchingCommitsByPath: { 'a.ts': ['abc1234'] }
    })
    expect(r.verdict).toBe('OK')
    expect(r.allowed.map((x) => x.path)).toEqual(['a.ts'])
    expect(r.violations).toEqual([])
  })

  it('Test 2: an owned changed path with an empty allow-list is a VIOLATION', () => {
    const r = judgeIntersection({
      owned: ['b.ts'],
      changed: ['b.ts'],
      allowList: [],
      touchingCommitsByPath: {}
    })
    expect(r.verdict).toBe('VIOLATION')
    expect(r.violations).toEqual([{ path: 'b.ts', reason: 'not-allow-listed' }])
  })

  it('Test 3: a new touching sha on an allow-listed path is not silently absorbed', () => {
    const r = judgeIntersection({
      owned: ['a.ts'],
      changed: ['a.ts'],
      allowList: [entry('a.ts', ['abc1234'])],
      touchingCommitsByPath: { 'a.ts': ['abc1234', 'def5678'] }
    })
    expect(r.verdict).toBe('VIOLATION')
    expect(r.violations).toEqual([{ path: 'a.ts', reason: 'unlisted-touching-commit' }])
  })

  it('Test 4: an allow-list entry that no longer intersects is a stale entry', () => {
    const r = judgeIntersection({
      owned: ['a.ts'],
      changed: ['z.ts'],
      allowList: [entry('a.ts')],
      touchingCommitsByPath: {}
    })
    expect(r.verdict).toBe('VIOLATION')
    expect(r.violations).toEqual([{ path: 'a.ts', reason: 'stale-allow-list-entry' }])
  })

  it('Test 5: a subsystem-prefix path outside the owned set is a violation; other paths are not', () => {
    const r = judgeIntersection({
      owned: ['a.ts'],
      changed: ['src/main/runtime/orchestration/new-file.ts', 'docs/dws/unrelated.md'],
      allowList: [],
      touchingCommitsByPath: {}
    })
    expect(r.violations).toEqual([
      { path: 'src/main/runtime/orchestration/new-file.ts', reason: 'subsystem-prefix' }
    ])
    expect(SUBSYSTEM_PREFIXES).toContain('src/main/conversation/')
  })

  it.each([
    ['empty reason', entry('a.ts', ['abc1234'], '')],
    ['short reason', entry('a.ts', ['abc1234'], 'too short')],
    ['empty sha list', entry('a.ts', [], REASON)]
  ])('Test 6: a malformed allow-list entry (%s) is BLOCKED', (_name, bad) => {
    const r = judgeIntersection({
      owned: ['a.ts'],
      changed: ['a.ts'],
      allowList: [bad],
      touchingCommitsByPath: {}
    })
    expect(r.verdict).toBe('BLOCKED')
    expect(r.rung).toBe('allow-list-malformed')
  })
})

describe('listChangedPaths in a throwaway repository', () => {
  it('Test 6b: a rename hides nothing; the OLD owned path is reported and judged', () => {
    const repo = mkdtempSync(path.join(tmpdir(), `p7-rename-${process.pid}-`))
    const git = (...args) =>
      execFileSync(
        process.env.GIT_EXE || 'git',
        ['-c', 'user.name=dws-test', '-c', 'user.email=dws-test@invalid', ...args],
        {
          cwd: repo,
          encoding: 'utf8'
        }
      )
    git('init', '-q')
    mkdirSync(path.join(repo, 'owned'))
    writeFileSync(path.join(repo, 'owned', 'a.txt'), 'line one\nline two\nline three\nline four\n')
    git('add', '.')
    git('commit', '-q', '-m', 'base')
    const base = git('rev-parse', 'HEAD').trim()
    mkdirSync(path.join(repo, 'moved'))
    git('mv', 'owned/a.txt', 'moved/a.txt')
    git('commit', '-q', '-m', 'rename')

    const runGit = createGitRunner(process.env.GIT_EXE || 'git', repo)
    const changed = listChangedPaths({ runGit, head: base })
    expect(changed).toEqual(['moved/a.txt', 'owned/a.txt'])

    const r = judgeIntersection({
      owned: ['owned/a.txt'],
      changed,
      allowList: [],
      touchingCommitsByPath: {}
    })
    expect(r.violations).toEqual([{ path: 'owned/a.txt', reason: 'not-allow-listed' }])

    // Control: with rename detection on, the old path vanishes, so the temp repo really exercises the rename.
    const withRenames = git('diff', '-M', '--name-only', `${base}..HEAD`)
      .split(/\r?\n/)
      .filter(Boolean)
    expect(withRenames).not.toContain('owned/a.txt')
  })
})

describe('sweep against real git data', () => {
  realIt(
    needsHead(
      'Test 7: control input yields exactly the federation subsystem file as the violation'
    ),
    { timeout: REAL_TIMEOUT },
    () => {
      const file = controlFile('t7', [
        'src/main/runtime/orchestration/review-records.ts',
        'src/cli/handler-group-manifest.ts'
      ])
      const r = spawnSweep(['--changed-paths-file', file])
      expect(r.status).toBe(1)
      const violations = r.stdout.split(/\r?\n/).filter((l) => l.startsWith('VIOLATION '))
      expect(violations.map((l) => l.split(' ')[1])).toEqual([
        'src/main/runtime/orchestration/review-records.ts'
      ])
      expect(r.stdout).toContain('ALLOWED src/cli/handler-group-manifest.ts')
    }
  )

  realIt(
    needsHead('Test 8: the real dws-changed set is green with exactly the one allowed touch'),
    { timeout: REAL_TIMEOUT },
    () => {
      const r = spawnSweep([])
      expect(r.status).toBe(0)
      expect(Number(/owned=(\d+)/.exec(r.stdout)[1])).toBeGreaterThanOrEqual(90)
      const allowed = r.stdout.split(/\r?\n/).filter((l) => l.startsWith('ALLOWED '))
      expect(allowed.map((l) => l.split(' ')[1])).toEqual(['src/cli/handler-group-manifest.ts'])
    }
  )

  realIt(
    needsHead('Test 10: an empty range (base equal to head) is BLOCKED owned-below-floor'),
    { timeout: REAL_TIMEOUT },
    () => {
      const r = spawnSweep(['--base', DEFAULT_HEAD, '--head', DEFAULT_HEAD])
      expect(r.status).toBe(2)
      expect(r.stdout).toContain('BLOCKED owned-below-floor')
    }
  )

  it(
    'Test 12: an unresolvable head is BLOCKED head-unresolvable',
    { timeout: REAL_TIMEOUT },
    () => {
      const r = spawnSweep(['--head', 'refs/heads/does-not-exist-p7'])
      expect(r.status).toBe(2)
      expect(r.stdout).toContain('BLOCKED head-unresolvable')
    }
  )

  it('Test 12b: the head probe tells a present ref from an absent one', () => {
    const repo = mkdtempSync(path.join(tmpdir(), `p8-headprobe-${process.pid}-`))
    const gitExe = process.env.GIT_EXE || 'git'
    const git = (...args) =>
      execFileSync(
        gitExe,
        ['-c', 'user.name=dws-test', '-c', 'user.email=dws-test@invalid', ...args],
        { cwd: repo, encoding: 'utf8' }
      )
    git('init', '-q')
    writeFileSync(path.join(repo, 'f.txt'), 'x\n')
    git('add', '.')
    git('commit', '-q', '-m', 'tip')
    git('branch', 'orca-x/probe-present')
    const runGit = createGitRunner(gitExe, repo)
    expect(headResolves(runGit, 'orca-x/probe-present')).toBe(true)
    expect(headResolves(runGit, 'orca-x/probe-absent')).toBe(false)
  })

  // Runs only where the skipped cases above cannot: it is the measured reason they were skipped.
  ;(FEDERATION_HEAD_PRESENT ? it.skip : it)(
    `Test 12c: with ${DEFAULT_HEAD} absent the sweep refuses and names it`,
    { timeout: REAL_TIMEOUT },
    () => {
      const r = spawnSweep([])
      expect(r.status).toBe(2)
      expect(r.stdout).toContain(`BLOCKED head-unresolvable ${DEFAULT_HEAD}`)
    }
  )
})

describe('sweep BLOCKED rungs and the floor drill', () => {
  it('Test 9: a base that is not an ancestor of HEAD is BLOCKED base-not-ancestor', () => {
    const repo = mkdtempSync(path.join(tmpdir(), `p7-ancestry-${process.pid}-`))
    const gitExe = process.env.GIT_EXE || 'git'
    const git = (...args) =>
      execFileSync(
        gitExe,
        ['-c', 'user.name=dws-test', '-c', 'user.email=dws-test@invalid', ...args],
        { cwd: repo, encoding: 'utf8' }
      )
    git('init', '-q')
    writeFileSync(path.join(repo, 'f.txt'), 'x\n')
    git('add', '.')
    git('commit', '-q', '-m', 'tip')
    const emptyTree = git('hash-object', '-t', 'tree', '--stdin').trim()
    const unrelated = git('commit-tree', emptyTree, '-m', 'unrelated').trim()
    const r = runOwnershipSweep({
      runGit: createGitRunner(gitExe, repo),
      argv: ['--base', unrelated, '--head', 'HEAD']
    })
    expect(r.code).toBe(2)
    expect(r.out.join('\n')).toContain('BLOCKED base-not-ancestor')
  })

  realIt(
    needsHead('Test 11: the floor is what stops a blind sweep (mutation drill)'),
    { timeout: REAL_TIMEOUT },
    () => {
      const realGit = createGitRunner(process.env.GIT_EXE || 'git', REPO_ROOT)
      const { paths } = deriveFederationOwnedPaths({
        runGit: realGit,
        base: DEFAULT_BASE,
        head: DEFAULT_HEAD
      })
      const outsidePrefixes = paths.find(
        (p) => !SUBSYSTEM_PREFIXES.some((prefix) => p.startsWith(prefix))
      )
      expect(outsidePrefixes).toBeTruthy()
      const file = controlFile('t11', [outsidePrefixes])
      // Blind git: the derivation sees no federation commits at all.
      const blindGit = (args) => (args[0] === 'rev-list' ? '' : realGit(args))
      const argv = ['--allow-list', 'none', '--changed-paths-file', file]

      const guarded = runOwnershipSweep({ runGit: blindGit, argv })
      expect(guarded.code).toBe(2)
      expect(guarded.out.join('\n')).toContain('BLOCKED owned-below-floor')

      // Same blind derivation with the floor lowered to 0 reports OK for a genuinely owned path.
      const unguarded = runOwnershipSweep({ runGit: blindGit, argv, floor: 0 })
      expect(unguarded.code).toBe(0)
      expect(unguarded.out.join('\n')).toContain('verdict=OK')

      // Control: the honest derivation flags the same path.
      const honest = runOwnershipSweep({ runGit: realGit, argv })
      expect(honest.code).toBe(1)
    }
  )
})
