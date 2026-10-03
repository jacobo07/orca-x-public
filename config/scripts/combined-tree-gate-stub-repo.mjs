import { spawnSync } from 'node:child_process'
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
import { afterEach } from 'vitest'

// Drives the real bash runner in a throwaway git repo whose build, Playwright, vitest and gates are
// stubs, so the runner's own guards are exercised without Electron or the real spine.
export const SCRIPTS = import.meta.dirname
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
  shadow) echo x > src/tracked.js ;;
esac
exit 0
`

const PLAYWRIGHT_SH = `#!/bin/sh
"$STUB_DIR/mutate.sh" spec
# STUB_SPAWN_PIDFILE: a child of the spec that outlives it. marker keeps the run's env marker (as the PTY
# daemon does), group and detached drop it, as Chromium does, and detached also leaves the session.
if [ -n "\${STUB_SPAWN_PIDFILE:-}" ]; then
  case "\${STUB_SPAWN_KIND:-marker}" in
    marker) setsid sleep 300 > /dev/null 2>&1 < /dev/null & ;;
    group) env -i sleep 300 > /dev/null 2>&1 < /dev/null & ;;
    detached) env -i setsid sleep 300 > /dev/null 2>&1 < /dev/null & ;;
  esac
  echo $! > "$STUB_SPAWN_PIDFILE"
fi
[ -n "\${STUB_SPEC_LINGER:-}" ] && sleep "$STUB_SPEC_LINGER"
echo "\${STUB_SPEC_ONLY:-unset}" > "$STUB_DIR/spec-env"
echo "\${CTG_LOCK_HELD:-unset}" > "$STUB_DIR/spec-lock-held"
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
export const liveChildren = []
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
export function isAlive(pid) {
  try {
    return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))
  } catch {
    return false
  }
}

const sh = (cwd, ...args) => spawnSync(REAL_GIT, args, { cwd, encoding: 'utf8' }).stdout.trim()

export function write(root, rel, text, mode) {
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
export function makeRepo({
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
  write(
    repo,
    '.gitignore',
    'node_modules/\nout/\nsrc/**/*.js\nsrc/**/*.d.ts\n/electron.vite.config.js\n.env*\n'
  )
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
    'combined-tree-gate-manifest.mjs',
    'combined-tree-gate-reaper.sh'
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
  // Why: no user scope, so the runner reaps by session; the scope test removes this stub.
  write(stubs, 'systemd-run', '#!/bin/sh\nexit 1\n', 0o755)
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
export function runGate(fx, { args = [], env = {}, verbatim = false } = {}) {
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
