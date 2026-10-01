#!/usr/bin/env node
// Laptop driver for the phase-15 two-host rung: ships the committed provisioner to the carrier host as one base64 ssh argument.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const here = import.meta.dirname
const carrierHost = process.env.ORCA_HWF_CARRIER_HOST || 'gex44'
const remoteVerbs = new Set(['create', 'status', 'witness', 'procs', 'teardown', 'install-stub'])

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

function runRemoteVerb(verb, root, outFile) {
  const script = readFileSync(path.join(here, 'hwf-two-host-disposable-root.sh'), 'utf8').replace(
    /\r\n/g,
    '\n'
  )
  const b64 = Buffer.from(script, 'utf8').toString('base64')
  const result = spawnSync(
    'ssh',
    [
      '-o',
      'ConnectTimeout=10',
      '-o',
      'BatchMode=yes',
      carrierHost,
      `echo ${b64} | base64 -d | bash -s -- ${verb} ${root}`
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

function parseKeyValues(text) {
  const out = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line)
    if (m) {
      out[m[1]] = m[2]
    }
  }
  return out
}

const [verb, root, ...rest] = process.argv.slice(2)

if (verb === 'new-root') {
  console.log(`/tmp/orca-hwf-p15-${utcStamp()}`)
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
  if (!root || !createFile || !keyPath || !out) {
    fail('usage: run-file <root> --create <create.txt> --key <path> --out <json>')
  }
  const kv = parseKeyValues(readFileSync(createFile, 'utf8'))
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
  writeFileSync(out, `${JSON.stringify(run, null, 2)}\n`)
  console.log(`run-file written ${out}`)
} else if (remoteVerbs.has(verb)) {
  if (!root) {
    fail(`usage: ${verb} <root> [--out <file>]`)
  }
  process.exit(runRemoteVerb(verb, root, argValue(rest, '--out')))
} else {
  fail(
    'usage: hwf-two-host-remote.mjs <new-root|create|status|witness|procs|teardown|fetch-key|run-file> ...'
  )
}
