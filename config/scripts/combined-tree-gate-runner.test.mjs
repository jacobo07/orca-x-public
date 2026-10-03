import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

// Drives the real bash runner in a throwaway git repo whose build, Playwright, vitest and gates are
// stubs, so the runner's own guards are exercised without Electron or the real spine.
const SCRIPTS = import.meta.dirname
const NODE_MAJOR = process.versions.node.split('.')[0]
const REAL_GIT = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim()
const JSONC_PARSER = (() => {
  let dir = dirname(fileURLToPath(import.meta.resolve('jsonc-parser')))
  while (!dir.endsWith('jsonc-parser')) {
    dir = dirname(dir)
  }
  return dir
})()

const MUTATE_SH = `#!/bin/sh
# Stub side effect: STUB_MUTATE_AT names the phase, STUB_MUTATE the damage done to the tree.
[ "\${STUB_MUTATE_AT:-}" = "$1" ] || exit 0
case "\${STUB_MUTATE:-}" in
  commit) git -c user.email=a@b -c user.name=n commit -q --allow-empty -m moved ;;
  dirty) echo more >> src/tracked.ts ;;
  untracked) echo x > src/stray.ts ;;
esac
exit 0
`

const PLAYWRIGHT_SH = `#!/bin/sh
"$STUB_DIR/mutate.sh" spec
# A detached child of the spec, as the PTY daemon is: only its inherited env ties it to the run.
if [ -n "\${STUB_SPAWN_PIDFILE:-}" ]; then
  setsid sleep 300 > /dev/null 2>&1 < /dev/null &
  echo $! > "$STUB_SPAWN_PIDFILE"
fi
echo "\${STUB_SPEC_ONLY:-unset}" > "$STUB_DIR/spec-env"
[ -n "\${STUB_CLOBBER:-}" ] && echo '{}' > "$STUB_CLOBBER"
echo "  1 passed (1.0s)"
`

const VITEST_SH = `#!/bin/sh
"$STUB_DIR/mutate.sh" units
echo "\${STUB_SPEC_ONLY:-unset}" > "$STUB_DIR/unit-env"
for a in "$@"; do
  case "$a" in --outputFile.json=*) echo '{"testResults":[]}' > "\${a#--outputFile.json=}" ;; esac
done
echo " Test Files  1 passed (1)"
echo "      Tests  1 passed (1)"
`

// A git that can be told to fail one subcommand, like a corrupt index would.
const gitWrapper = () => `#!/bin/sh
[ -n "\${STUB_GIT_FAIL:-}" ] && [ "$1" = "$STUB_GIT_FAIL" ] && exit 128
exec ${REAL_GIT} "$@"
`

const ENTRY_POINT_STUB = `import fs from 'node:fs'
import path from 'node:path'
export function isEntryPoint(argvPath, moduleFilename) {
  const real = (p) => fs.realpathSync(path.resolve(p))
  return Boolean(argvPath) && real(argvPath) === real(moduleFilename)
}
`

const created = []
const liveChildren = []
afterEach(() => {
  for (const pid of liveChildren.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Zombies count as gone: a killed child waiting for its reaper is not running.
function isAlive(pid) {
  try {
    return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))
  } catch {
    return false
  }
}

const sh = (cwd, ...args) => spawnSync(REAL_GIT, args, { cwd, encoding: 'utf8' }).stdout.trim()

function write(root, rel, text, mode) {
  const file = join(root, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
  if (mode) {
    chmodSync(file, mode)
  }
}

const baseManifest = (base) => ({
  schema: 'combined-tree-gate/1',
  changedFilesBase: base,
  specs: [{ name: 'alpha', minPassed: 1 }],
  unitGroups: [{ name: 'u', paths: ['src/foo'], minPassedFiles: 1 }],
  staticGates: [
    { name: 'stub', argv: ['node', 'config/scripts/stub-gate.mjs'] },
    {
      name: 'lint',
      argv: ['node', 'config/scripts/stub-gate.mjs', '--changed'],
      changedFiles: true
    }
  ]
})

/** A git repo holding the real runner and contract, with every heavy tool replaced by a stub. */
function makeRepo({
  edit = (m) => m,
  lockText = 'lockfile: 1\n',
  installedLock = lockText,
  nodeEngine = NODE_MAJOR
} = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ctg-runner-')))
  created.push(root)
  const repo = join(root, 'repo')
  mkdirSync(repo)
  const git = (...args) => sh(repo, ...args)
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'a@b')
  git('config', 'user.name', 'n')
  write(repo, 'src/old-name.mjs', Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n'))
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  const base = git('rev-parse', 'HEAD')
  git('mv', 'src/old-name.mjs', 'src/new-name.mjs')
  write(
    repo,
    'src/new-name.mjs',
    `${Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')}\nedited\n`
  )
  write(repo, 'package.json', JSON.stringify({ engines: { node: nodeEngine } }))
  write(repo, '.gitignore', 'node_modules/\nout/\n')
  write(repo, 'pnpm-lock.yaml', lockText)
  write(repo, 'src/tracked.ts', 'export {}\n')
  write(repo, 'src/foo/a.test.ts', 'export {}\n')
  write(repo, 'tests/e2e/alpha.spec.ts', 'export {}\n')
  write(repo, 'config/combined-tree-gate.jsonc', JSON.stringify(edit(baseManifest(base))))
  write(repo, 'config/scripts/build-relay.mjs', '')
  write(repo, 'config/scripts/check-mobile-capability-aperture.mjs', ENTRY_POINT_STUB)
  for (const name of [
    'combined-tree-gate.sh',
    'combined-tree-gate-contract.mjs',
    'combined-tree-gate-manifest.mjs'
  ]) {
    copyFileSync(join(SCRIPTS, name), join(repo, 'config/scripts', name))
  }
  // Why: the runner's gate steps call `node config/scripts/stub-gate.mjs`, which mutates via this file.
  write(
    repo,
    'config/scripts/stub-gate.mjs',
    `import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'\nspawnSync(process.env.STUB_DIR + '/mutate.sh', ['gates'])\nconsole.log('ok')\n`
  )
  git('add', '-A')
  git('commit', '-q', '-m', 'tree')
  const stubs = join(root, 'stubs')
  write(stubs, 'mutate.sh', MUTATE_SH, 0o755)
  write(stubs, 'git', gitWrapper(), 0o755)
  write(stubs, 'pgrep', '#!/bin/sh\nexit 1\n', 0o755)
  write(
    stubs,
    'xvfb-run',
    '#!/bin/sh\nwhile [ "$1" = -a ] || [ "$1" = -s ]; do [ "$1" = -s ] && shift; shift; done\nexec "$@"\n',
    0o755
  )
  const modules = join(repo, 'node_modules')
  write(modules, '.bin/electron-vite', '#!/bin/sh\nexit 0\n', 0o755)
  write(modules, '.bin/playwright', PLAYWRIGHT_SH, 0o755)
  write(modules, '.bin/vitest', VITEST_SH, 0o755)
  write(modules, 'typescript/bin/tsc', 'process.exit(0)\n')
  if (installedLock !== null) {
    write(modules, '.pnpm/lock.yaml', installedLock)
  }
  symlinkSync(JSONC_PARSER, join(modules, 'jsonc-parser'))
  const runs = join(root, 'runs')
  mkdirSync(runs)
  return { root, repo, runs, stubs, base, head: () => git('rev-parse', 'HEAD') }
}

/** Runs the runner in `fx.repo`; returns its exit status, output and the summary it wrote. */
function runGate(fx, { args = [], env = {}, verbatim = false } = {}) {
  const head = fx.head()
  const result = spawnSync(
    'bash',
    [
      join(fx.repo, 'config/scripts/combined-tree-gate.sh'),
      ...(verbatim ? [] : ['--label', 't', '--expect', head.slice(0, 9)]),
      ...args
    ],
    {
      cwd: fx.repo,
      encoding: 'utf8',
      timeout: 90_000,
      env: {
        PATH: [fx.stubs, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
        HOME: fx.root,
        LANG: 'C',
        STUB_DIR: fx.stubs,
        CTG_RUNS_DIR: fx.runs,
        ...env
      }
    }
  )
  const dir = join(fx.runs, `t-${head.slice(0, 9)}`)
  const summaryPath = join(dir, 'summary.txt')
  const summary = existsSync(summaryPath) ? readFileSync(summaryPath, 'utf8') : ''
  const lines = result.stdout.trim().split('\n')
  return {
    ...result,
    head,
    dir,
    summary,
    verdictLine: lines.findLast((l) => l.startsWith('TIP_VERDICT'))
  }
}

const linux = describe.skipIf(process.platform !== 'linux')

linux('combined-tree-gate.sh against a stub tree', () => {
  it('reads an undisturbed stub run as GREEN (control)', () => {
    // Arrange
    const fx = makeRepo()
    // Act
    const run = runGate(fx)
    // Assert
    expect(run.status, run.stdout + run.stderr).toBe(0)
    expect(run.verdictLine).toMatch(new RegExp(`^TIP_VERDICT GREEN head=${run.head}`))
  })

  it('mints a TREE_AT line at every phase boundary, all equal to the start HEAD with no dirt', () => {
    const fx = makeRepo()
    const run = runGate(fx)
    const phases = ['build', 'spec-alpha', 'units', 'gates', 'end']
    for (const phase of phases) {
      expect(run.summary).toContain(`TREE_AT ${phase} head=${run.head} dirty=0\n`)
    }
  })

  it.each([
    ['spec', 'commit'],
    ['spec', 'dirty'],
    ['units', 'commit'],
    ['units', 'dirty'],
    ['gates', 'commit'],
    ['gates', 'dirty']
  ])('reads a tree that changed during %s (%s) as RED, not GREEN', (phase, damage) => {
    // Arrange
    const fx = makeRepo()
    // Act
    const run = runGate(fx, { env: { STUB_MUTATE_AT: phase, STUB_MUTATE: damage } })
    // Assert
    expect(run.verdictLine).toMatch(/^TIP_VERDICT RED /)
    expect(run.status).toBe(99)
    const name = { spec: 'spec-alpha', units: 'units', gates: 'gates' }[phase]
    expect(run.summary).toMatch(new RegExp(`^TREE_AT ${name} head=\\S+ dirty=\\d+$`, 'm'))
  })

  describe('manifest identity (WR-01)', () => {
    const sha16 = (path) =>
      createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)

    it('names the manifest and whether it is the committed one in the GREEN line', () => {
      // Arrange
      const fx = makeRepo()
      // Act
      const run = runGate(fx)
      // Assert
      const committed = join(fx.repo, 'config/combined-tree-gate.jsonc')
      expect(run.verdictLine).toBe(
        `TIP_VERDICT GREEN head=${run.head} manifest=${sha16(committed)} committed=1`
      )
      expect(readFileSync(join(run.dir, 'manifest.jsonc'), 'utf8')).toBe(
        readFileSync(committed, 'utf8')
      )
    })

    it('marks a run of an out-of-tree manifest committed=0 with that manifest hash', () => {
      const fx = makeRepo()
      const lax = join(fx.root, 'lax.jsonc')
      const reduced = JSON.parse(
        readFileSync(join(fx.repo, 'config/combined-tree-gate.jsonc'), 'utf8')
      )
      reduced.staticGates = reduced.staticGates.slice(0, 1)
      writeFileSync(lax, JSON.stringify(reduced))
      const run = runGate(fx, { args: ['--manifest', lax] })
      expect(run.verdictLine).toBe(
        `TIP_VERDICT GREEN head=${run.head} manifest=${sha16(lax)} committed=0`
      )
    })

    it('judges the manifest it started with when the file is edited mid-run', () => {
      const fx = makeRepo()
      const moving = join(fx.root, 'moving.jsonc')
      copyFileSync(join(fx.repo, 'config/combined-tree-gate.jsonc'), moving)
      const started = sha16(moving)
      const run = runGate(fx, { args: ['--manifest', moving], env: { STUB_CLOBBER: moving } })
      expect(run.verdictLine).toBe(
        `TIP_VERDICT GREEN head=${run.head} manifest=${started} committed=1`
      )
      expect(run.status).toBe(0)
    })
  })

  describe('specEnv (WR-02)', () => {
    it('refuses a manifest whose specEnv names a runner variable before anything runs', () => {
      // Arrange
      const fx = makeRepo({ edit: (m) => ({ ...m, specEnv: { MANIFEST: '/tmp/lax.jsonc' } }) })
      // Act
      const run = runGate(fx)
      // Assert
      expect(run.status).toBe(97)
      expect(run.stdout).toContain('specEnv name MANIFEST is reserved')
      expect(existsSync(run.dir)).toBe(false)
    })

    it('gives specEnv to the specs only, not to the unit groups or gates', () => {
      const fx = makeRepo({ edit: (m) => ({ ...m, specEnv: { STUB_SPEC_ONLY: '1' } }) })
      const run = runGate(fx)
      expect(run.status, run.stdout).toBe(0)
      expect(readFileSync(join(fx.stubs, 'spec-env'), 'utf8').trim()).toBe('1')
      expect(readFileSync(join(fx.stubs, 'unit-env'), 'utf8').trim()).toBe('unset')
    })
  })

  describe('process reaping (WR-03)', () => {
    it('kills what the run started and leaves a daemon of this tree that it did not start', () => {
      // Arrange
      const fx = makeRepo()
      const pidFile = join(fx.root, 'spawned.pid')
      const foreign = spawn(
        'bash',
        ['-c', 'exec -a "$0" sleep 300', `node ${fx.repo}/out/main/daemon-entry.js`],
        {
          stdio: 'ignore',
          detached: true
        }
      )
      liveChildren.push(foreign.pid)
      expect(readFileSync(`/proc/${foreign.pid}/cmdline`, 'utf8')).toContain(`${fx.repo}/out/main`)
      // Act
      const run = runGate(fx, { env: { STUB_SPAWN_PIDFILE: pidFile } })
      // Assert
      const started = Number(readFileSync(pidFile, 'utf8'))
      liveChildren.push(started)
      expect(run.status, run.stdout).toBe(0)
      expect(isAlive(started)).toBe(false)
      expect(isAlive(foreign.pid)).toBe(true)
    })
  })

  describe('lockfile parity (WR-04)', () => {
    it('accepts a node_modules whose installed lock equals the tree lockfile (control)', () => {
      const run = runGate(makeRepo(), { args: ['--dry-run'] })
      expect(run.status, run.stdout).toBe(0)
    })

    it('refuses an installed lock that differs from the tree lockfile even with a local node_modules', () => {
      const fx = makeRepo({ installedLock: 'lockfile: 2\n' })
      const run = runGate(fx, { args: ['--dry-run'] })
      expect(run.status).toBe(94)
      expect(run.stdout).toMatch(/^LOCK_MISMATCH here=\S+ node_modules_installed=\S+/m)
    })

    it('refuses when there is no installed lock and no other checkout to compare against', () => {
      const run = runGate(makeRepo({ installedLock: null }), { args: ['--dry-run'] })
      expect(run.status).toBe(94)
      expect(run.stdout).toContain('REFUSED_LOCK no meaningful comparison')
    })

    it('compares against CTG_LOCK_OWNER when the installed lock is absent', () => {
      const fx = makeRepo({ installedLock: null })
      const owner = join(fx.root, 'owner')
      write(owner, 'pnpm-lock.yaml', 'lockfile: 1\n')
      expect(runGate(fx, { args: ['--dry-run'], env: { CTG_LOCK_OWNER: owner } }).status).toBe(0)
      write(owner, 'pnpm-lock.yaml', 'lockfile: 9\n')
      expect(runGate(fx, { args: ['--dry-run'], env: { CTG_LOCK_OWNER: owner } }).status).toBe(94)
    })
  })

  describe('untracked files (WR-05)', () => {
    it('refuses a tree holding an untracked source file that the build would read', () => {
      const fx = makeRepo()
      write(fx.repo, 'src/untracked-import.ts', 'export {}\n')
      const run = runGate(fx, { args: ['--dry-run'] })
      expect(run.status).toBe(92)
      expect(run.stdout).toContain('REFUSED_DIRTY_TREE dirty=1')
    })

    it('ignores gitignored files and the agent session directory (controls)', () => {
      const fx = makeRepo()
      write(fx.repo, 'out/main/index.js', '//\n')
      write(fx.repo, '.claude/state.json', '{}\n')
      const run = runGate(fx, { args: ['--dry-run'] })
      expect(run.status, run.stdout).toBe(0)
    })

    it('does not count its own evidence directory when it sits inside the tree', () => {
      const fx = makeRepo()
      const inside = join(fx.repo, 'ctg-evidence')
      mkdirSync(inside)
      const run = runGate(fx, { env: { CTG_RUNS_DIR: inside } })
      expect(run.status, run.stdout).toBe(0)
      expect(run.verdictLine).toMatch(/^TIP_VERDICT GREEN /)
    })

    it('reads a file that appears untracked during a spec as RED', () => {
      const fx = makeRepo()
      const run = runGate(fx, { env: { STUB_MUTATE_AT: 'spec', STUB_MUTATE: 'untracked' } })
      expect(run.status).toBe(99)
      expect(run.summary).toContain(`TREE_AT spec-alpha head=${run.head} dirty=1\n`)
    })
  })

  describe('git failures fail closed (WR-06)', () => {
    it('refuses (92) instead of reading a failing git status as a clean tree', () => {
      const run = runGate(makeRepo(), { args: ['--dry-run'], env: { STUB_GIT_FAIL: 'status' } })
      expect(run.status).toBe(92)
      expect(run.stdout).toContain('REFUSED_DIRTY_TREE dirty=unknown')
    })

    it('refuses (90) when HEAD cannot be read', () => {
      const run = runGate(makeRepo(), { args: ['--dry-run'], env: { STUB_GIT_FAIL: 'rev-parse' } })
      expect(run.status).toBe(90)
      expect(run.stdout).toContain('REFUSED_TREE cannot read HEAD')
    })

    it('reads a failing git diff as RED changed-files gates, never as "no changed files"', () => {
      const fx = makeRepo()
      const run = runGate(fx, { env: { STUB_GIT_FAIL: 'diff' } })
      expect(run.summary).toMatch(/^GATE lint exit=unknown /m)
      expect(run.summary).not.toContain('no changed files')
      expect(run.verdictLine).toMatch(/^TIP_VERDICT RED /)
      expect(run.status).toBe(1)
    })
  })

  describe('changed-file scope (WR-07)', () => {
    it('includes a file renamed and edited since the base in the lint and format scope', () => {
      // Arrange: makeRepo renames src/old-name.mjs to src/new-name.mjs with an edit after the base commit
      const fx = makeRepo()
      // Act
      const run = runGate(fx)
      // Assert
      const changed = readFileSync(join(run.dir, 'changed-files.txt'), 'utf8').split('\n')
      expect(changed).toContain('src/new-name.mjs')
      expect(run.summary).toMatch(/^CHANGED_FILES \d+ since /m)
    })
  })

  describe('single run per checkout (WR-09)', () => {
    function holdLock(fx) {
      const ready = join(fx.root, 'lock-ready')
      const holder = spawn(
        'flock',
        ['-x', join(fx.repo, '.git', 'ctg.lock'), 'sh', '-c', `echo up > ${ready}; sleep 120`],
        { stdio: 'ignore', detached: true }
      )
      liveChildren.push(holder.pid)
      for (let i = 0; i < 100 && !existsSync(ready); i++) {
        spawnSync('sleep', ['0.1'])
      }
      expect(existsSync(ready)).toBe(true)
    }

    it('refuses (98) a second run while another run holds the checkout lock', () => {
      // Arrange
      const fx = makeRepo()
      holdLock(fx)
      // Act
      const run = runGate(fx)
      // Assert
      expect(run.status, run.stdout).toBe(98)
      expect(run.stdout).toContain('REFUSED_LOCKED')
      expect(existsSync(run.dir)).toBe(false)
    })

    it('still plans a dry-run while the lock is held, and runs once it is free (controls)', () => {
      const fx = makeRepo()
      holdLock(fx)
      expect(runGate(fx, { args: ['--dry-run'] }).status).toBe(0)
      const free = makeRepo()
      expect(runGate(free).status).toBe(0)
    })
  })

  describe('verdict boundary guards (WR-08)', () => {
    const verdictOnly = (stubNode) => {
      const fx = makeRepo()
      write(fx.stubs, 'node', `#!/bin/sh\n${stubNode}\n`, 0o755)
      write(fx.root, 'summary.txt', 'x\n')
      return runGate(fx, { args: ['--verdict-only', join(fx.root, 'summary.txt')], verbatim: true })
    }

    it.each([
      ['printed nothing', 'exit 0', 'printed 0 verdict lines'],
      [
        'printed two verdict lines',
        'echo "TIP_VERDICT GREEN a"; echo "TIP_VERDICT GREEN b"; exit 0',
        'printed 2 verdict lines'
      ],
      [
        'exited 1 after printing GREEN',
        'echo "TIP_VERDICT GREEN a"; exit 1',
        'exit=1 disagrees with its last line'
      ]
    ])('reads a contract that %s as NO_VERDICT with exit 2', (_label, script, why) => {
      const run = verdictOnly(script)
      expect(run.status).toBe(2)
      expect(run.stdout).toContain(`TIP_VERDICT NO_VERDICT contract ${why}`)
    })

    it('passes a well-formed GREEN through with exit 0 (control)', () => {
      const run = verdictOnly('echo "TIP_VERDICT GREEN head=a manifest=b committed=1"; exit 0')
      expect(run.status).toBe(0)
      expect(run.verdictLine).toBe('TIP_VERDICT GREEN head=a manifest=b committed=1')
    })
  })

  describe('preflight refusal codes (WR-08)', () => {
    const dry = (fx, opts = {}) =>
      runGate(fx, { args: ['--dry-run', ...(opts.args ?? [])], ...opts })

    it('plans a dry-run without building or writing (control)', () => {
      const fx = makeRepo()
      const run = dry(fx)
      expect(run.status, run.stdout).toBe(0)
      expect(run.stdout).toMatch(
        /^DRY_RUN\n[\s\S]*PLAN_COUNTS specs=1 units=1 gates=2\nWOULD_WRITE /
      )
      expect(existsSync(run.dir)).toBe(false)
    })

    it.each([
      ['no label', ['--expect', 'abcdef1'], 2, 'REFUSED_USAGE --label'],
      ['a malformed sha', ['--label', 't', '--expect', 'zz'], 2, 'REFUSED_USAGE --expect'],
      [
        'an unknown argument',
        ['--label', 't', '--expect', 'abcdef1', '--nope'],
        2,
        'unknown argument'
      ]
    ])('refuses %s with exit %i', (_label, args, code, text) => {
      const run = runGate(makeRepo(), { args: ['--dry-run', ...args], verbatim: true })
      expect(run.status).toBe(code)
      expect(run.stdout).toContain(text)
    })

    it('refuses a checkout that is not a git work tree (90)', () => {
      const fx = makeRepo()
      const loose = join(fx.root, 'loose')
      mkdirSync(loose)
      copyFileSync(join(SCRIPTS, 'combined-tree-gate.sh'), join(loose, 'combined-tree-gate.sh'))
      const run = spawnSync(
        'bash',
        [join(loose, 'combined-tree-gate.sh'), '--label', 't', '--expect', 'abcdef1'],
        {
          encoding: 'utf8',
          env: { PATH: process.env.PATH, GIT_CEILING_DIRECTORIES: fx.root }
        }
      )
      expect(run.status).toBe(90)
      expect(run.stdout).toContain('REFUSED_TREE')
    })

    it('refuses a HEAD that is not the expected one (91)', () => {
      const run = dry(makeRepo(), { args: ['--expect', 'deadbeef'] })
      expect(run.status).toBe(91)
      expect(run.stdout).toContain('REFUSED_HEAD_MISMATCH')
    })

    it('refuses a run dir that already exists (93)', () => {
      const fx = makeRepo()
      mkdirSync(join(fx.runs, `t-${fx.head().slice(0, 9)}`))
      const run = dry(fx)
      expect(run.status).toBe(93)
      expect(run.stdout).toContain('REFUSED_RUN_DIR_EXISTS')
    })

    it('refuses a node whose major is not engines.node (96)', () => {
      const run = dry(makeRepo({ nodeEngine: '1' }))
      expect(run.status).toBe(96)
      expect(run.stdout).toContain('REFUSED_TOOLCHAIN')
    })

    it('refuses when CTG_RUNS_DIR is unset (96)', () => {
      const run = dry(makeRepo(), { env: { CTG_RUNS_DIR: '' } })
      expect(run.status).toBe(96)
      expect(run.stdout).toContain('REFUSED missing env CTG_RUNS_DIR')
    })

    it('refuses a required env that is unset or names a missing directory (96)', () => {
      const fx = makeRepo({
        edit: (m) => ({ ...m, requiredEnv: [{ name: 'STUB_REQUIRED', pathList: true }] })
      })
      expect(dry(fx).stdout).toContain('REFUSED missing env STUB_REQUIRED')
      const missing = dry(fx, { env: { STUB_REQUIRED: join(fx.root, 'nope') } })
      expect(missing.status).toBe(96)
      expect(missing.stdout).toContain('is not an existing directory')
      expect(dry(fx, { env: { STUB_REQUIRED: fx.root } }).status).toBe(0)
    })

    it.each([
      ['an invalid manifest', (m) => ({ ...m, schema: 'x' }), 'REFUSED_MANIFEST'],
      [
        'a spec without a file',
        (m) => ({ ...m, specs: [{ name: 'ghost', minPassed: 1 }] }),
        'has no tests/e2e/ghost.spec.ts'
      ],
      [
        'a base that is not a commit',
        (m) => ({ ...m, changedFilesBase: 'deadbeef' }),
        'is not a commit here'
      ]
    ])('refuses %s (97)', (_label, edit, text) => {
      const run = dry(makeRepo({ edit }))
      expect(run.status).toBe(97)
      expect(run.stdout).toContain(text)
    })
  })
})
