#!/usr/bin/env node
// Laptop driver for the phase-15/16/20 two-host rungs: ships the committed provisioner to the carrier host as one base64 ssh argument.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

const here = import.meta.dirname
const carrierHost = process.env.ORCA_HWF_CARRIER_HOST || 'gex44'
const remoteVerbs = new Set([
  'create',
  'status',
  'witness',
  'procs',
  'teardown',
  'install-stub',
  'seed-p16',
  'git-compat-p16',
  'seed-p20',
  'edit-prepare-p20',
  'stat-shim-p20',
  'serve-p20',
  'serve-query-p20'
])
// These take no root; every other verb's root argument is checked.
const ROOTLESS_VERBS = new Set(['new-root', 'new-nonce', 'seed-local-p16'])
const ROOT_SHAPE = /^\/tmp\/orca-hwf-p(?:1[56]|20|23)-[0-9A-Za-z]+$/
const NONCE_SHAPE = /^[0-9a-f]{16}$/
const EXTRA_SHAPE = /^\/[A-Za-z0-9_./-]+$/
// The serve launch line: words and env assignments only, no quotes or shell metacharacters.
const LAUNCH_SHAPE = /^[A-Za-z0-9_./= -]+$/

// Same flag set and fixed identity as the provisioner's seed_git, so both hosts mint one first commit (W10).
const SEED_GIT_FLAGS = [
  '-c',
  'core.autocrlf=false',
  '-c',
  'core.safecrlf=false',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.hooksPath=',
  '-c',
  'init.defaultBranch=main',
  '-c',
  'user.name=hwf16',
  '-c',
  'user.email=hwf16@example.invalid'
]
const SEED_GIT_ENV = {
  GIT_AUTHOR_NAME: 'hwf16',
  GIT_AUTHOR_EMAIL: 'hwf16@example.invalid',
  GIT_AUTHOR_DATE: '2026-10-01T00:00:00+0000',
  GIT_COMMITTER_NAME: 'hwf16',
  GIT_COMMITTER_EMAIL: 'hwf16@example.invalid',
  GIT_COMMITTER_DATE: '2026-10-01T00:00:00+0000'
}

function fail(message) {
  console.error(message)
  process.exit(2)
}

function argValue(args, name) {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}

function utcStamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
}

function runRemoteVerb(verb, root, extras, outFile) {
  const script = readFileSync(path.join(here, 'hwf-two-host-disposable-root.sh'), 'utf8').replace(
    /\r\n/g,
    '\n'
  )
  const b64 = Buffer.from(script, 'utf8').toString('base64')
  // Extras are shape-validated (no quotes), so single quotes keep a launch line as one argument.
  const tail = extras.map((extra) => ` '${extra}'`).join('')
  const result = spawnSync(
    'ssh',
    [
      '-o',
      'ConnectTimeout=10',
      '-o',
      'BatchMode=yes',
      carrierHost,
      `echo ${b64} | base64 -d | bash -s -- ${verb} ${root}${tail}`
    ],
    { encoding: 'utf8' }
  )
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`
  process.stdout.write(text)
  if (outFile) {
    writeFileSync(outFile, text)
  }
  return result.status ?? 1
}

// PowerShell 5.1 redirection writes UTF-16LE or a UTF-8 BOM; both decode to the same text here.
function readTextFile(file) {
  const bytes = readFileSync(file)
  const text =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? bytes.toString('utf16le').slice(1)
      : bytes.toString('utf8').replace(/^\uFEFF/, '')
  return text
}

function parseKeyValues(text) {
  const out = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line)
    if (m) {
      out[m[1]] = m[2]
    }
  }
  return out
}

function seedGit(cwd, args, env) {
  const r = spawnSync('git', [...SEED_GIT_FLAGS, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  })
  if (r.status !== 0) {
    fail(`git ${args.join(' ')} failed: ${r.stdout ?? ''}${r.stderr ?? ''}`)
  }
  return (r.stdout ?? '').trim()
}

function seedLocal(args) {
  const nonce = argValue(args, '--nonce')
  const dir = argValue(args, '--dir')
  if (!nonce || !NONCE_SHAPE.test(nonce)) {
    fail(`REFUSED nonce=${nonce}`)
  }
  if (!dir || !path.isAbsolute(dir)) {
    fail(`REFUSED dir=${dir}`)
  }
  const replica = path.join(dir, 'p16-replica')
  if (existsSync(replica)) {
    console.error(`REFUSED exists=${replica}`)
    process.exit(3)
  }
  mkdirSync(replica, { recursive: true })
  seedGit(replica, ['init', '-q'], SEED_GIT_ENV)
  writeFileSync(path.join(replica, 'seed.txt'), `HWF16_${nonce}\n`)
  seedGit(replica, ['add', 'seed.txt'], SEED_GIT_ENV)
  seedGit(replica, ['commit', '-q', '-m', 'hwf p16 seed'], SEED_GIT_ENV)
  const seedRoot = seedGit(replica, ['rev-parse', 'HEAD'], {})
  writeFileSync(path.join(replica, 'host.txt'), `${os.hostname()}\n`)
  seedGit(replica, ['add', 'host.txt'], {})
  seedGit(replica, ['commit', '-q', '-m', 'hwf p16 host commit'], {})
  console.log(`SEED_ROOT=${seedRoot}`)
  console.log(`LOCAL_REPLICA_PATH=${replica}`)
  console.log(`LOCAL_REPLICA_HEAD=${seedGit(replica, ['rev-parse', 'HEAD'], {})}`)
}

const [verb, root, ...rest] = process.argv.slice(2)

// Anchored shape of what new-root mints; refuses locally before the root reaches any ssh/scp argument.
if (!ROOTLESS_VERBS.has(verb) && root !== undefined && !ROOT_SHAPE.test(root)) {
  console.error(`REFUSED root=${root}`)
  process.exit(2)
}

if (verb === 'new-root') {
  const phase = argValue(process.argv.slice(3), '--phase') ?? '15'
  if (phase !== '15' && phase !== '16' && phase !== '20' && phase !== '23') {
    fail(`REFUSED phase=${phase}`)
  }
  console.log(`/tmp/orca-hwf-p${phase}-${utcStamp()}`)
} else if (verb === 'new-nonce') {
  console.log(randomBytes(8).toString('hex'))
} else if (verb === 'seed-local-p16') {
  seedLocal(process.argv.slice(3))
} else if (verb === 'fetch-key') {
  const dir = argValue(rest, '--to')
  if (!root || !dir) {
    fail('usage: fetch-key <root> --to <dir>')
  }
  mkdirSync(dir, { recursive: true })
  const r = spawnSync(
    'scp',
    ['-o', 'BatchMode=yes', `${carrierHost}:${root}/client_key`, path.join(dir, 'client_key')],
    {
      stdio: 'inherit'
    }
  )
  process.exit(r.status ?? 1)
} else if (verb === 'run-file') {
  const createFile = argValue(rest, '--create')
  const keyPath = argValue(rest, '--key')
  const out = argValue(rest, '--out')
  const seedFile = argValue(rest, '--seed')
  const localSeedFile = argValue(rest, '--local-seed')
  if (!root || !createFile || !keyPath || !out) {
    fail(
      'usage: run-file <root> --create <create.txt> --key <path> --out <json> [--seed <seed-remote.txt> --local-seed <seed-local.txt>]'
    )
  }
  if (Boolean(seedFile) !== Boolean(localSeedFile)) {
    fail('run-file: --seed and --local-seed go together')
  }
  const kv = parseKeyValues(readTextFile(createFile))
  const run = {
    root,
    port: Number(kv.PORT),
    fingerprint: kv.FP,
    hostname: kv.HOSTNAME,
    repo: kv.REPO,
    seedNonce: kv.SEED_NONCE,
    seedHead: kv.SEED_HEAD,
    user: kv.USER,
    keyPath,
    carrierHost
  }
  if (seedFile) {
    const remote = parseKeyValues(readFileSync(seedFile, 'utf8'))
    const local = parseKeyValues(readFileSync(localSeedFile, 'utf8'))
    if (!remote.SEED_ROOT || remote.SEED_ROOT !== local.SEED_ROOT) {
      fail(`INCONCLUSIVE seed roots differ remote=${remote.SEED_ROOT} local=${local.SEED_ROOT}`)
    }
    Object.assign(run, {
      seedRoot: remote.SEED_ROOT,
      replicaPath: remote.REPLICA_PATH,
      replicaHead: remote.REPLICA_HEAD,
      forkPath: remote.FORK_PATH,
      forkHead: remote.FORK_HEAD,
      shallowPath: remote.SHALLOW_PATH,
      unbornPath: remote.UNBORN_PATH,
      latePath: remote.LATE_PATH,
      localReplicaPath: local.LOCAL_REPLICA_PATH,
      localReplicaHead: local.LOCAL_REPLICA_HEAD
    })
  }
  const seed20File = argValue(rest, '--seed20')
  if (seed20File) {
    const seed = parseKeyValues(readTextFile(seed20File))
    if (!seed.PROJECT_PATH || !seed.CONTRACT_SHA256 || !seed.SHIM_DIR) {
      fail(`run-file: ${seed20File} lacks PROJECT_PATH, CONTRACT_SHA256 or SHIM_DIR`)
    }
    Object.assign(run, {
      projectPath: seed.PROJECT_PATH,
      contractSha256: seed.CONTRACT_SHA256,
      shimDir: seed.SHIM_DIR
    })
  }
  const sentinelNonce = argValue(rest, '--sentinel-nonce')
  if (sentinelNonce !== undefined) {
    if (!NONCE_SHAPE.test(sentinelNonce)) {
      fail('REFUSED sentinel-nonce')
    }
    run.sentinelNonce = sentinelNonce
  }
  writeFileSync(out, `${JSON.stringify(run, null, 2)}\n`)
  console.log(`run-file written ${out}`)
} else if (remoteVerbs.has(verb)) {
  if (!root) {
    fail(`usage: ${verb} <root> [<extra> [<extra2>]] [--out <file>]`)
  }
  const extras = []
  for (const candidate of rest.slice(0, 2)) {
    if (candidate.startsWith('--')) {
      break
    }
    extras.push(candidate)
  }
  for (const [i, extra] of extras.entries()) {
    const ok =
      NONCE_SHAPE.test(extra) ||
      EXTRA_SHAPE.test(extra) ||
      (i === 1 && verb === 'serve-p20' && LAUNCH_SHAPE.test(extra))
    if (!ok) {
      fail(`REFUSED extra=${extra}`)
    }
  }
  process.exit(runRemoteVerb(verb, root, extras, argValue(rest, '--out')))
} else {
  fail(
    'usage: hwf-two-host-remote.mjs <new-root [--phase 15|16|20|23]|new-nonce|seed-local-p16 --nonce <n> --dir <d>|create|status|witness|procs|teardown|install-stub|seed-p16|git-compat-p16|seed-p20|edit-prepare-p20|stat-shim-p20|serve-p20|serve-query-p20|fetch-key|run-file> ...'
  )
}
