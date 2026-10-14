#!/usr/bin/env node
// Refusal drill for the two-host root guard: every DRILL line is derived from a captured exit code, never typed.
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

const here = import.meta.dirname
const driver = path.join(here, 'hwf-two-host-remote.mjs')
const carrierHost = process.env.ORCA_HWF_CARRIER_HOST || 'gex44'
const SSH_OWN_FAILURE = 255

const badRoots = [
  ['p18', '/tmp/orca-hwf-p18-X'],
  ['bare17', '/tmp/orca-hwf-p17-'],
  ['dotdot17', '/tmp/orca-hwf-p17-../x'],
  ['semicolon17', '/tmp/orca-hwf-p17-a;id'],
  ['slash17', '/tmp/orca-hwf-p17-a/'],
  ['bare', '/tmp/orca-hwf-p16-'],
  ['dotdot', '/tmp/orca-hwf-p16-../x'],
  ['semicolon', '/tmp/orca-hwf-p16-a;id'],
  ['slash', '/tmp/orca-hwf-p16-a/'],
  ['not-ours', '/tmp/not-ours'],
  ['p21', '/tmp/orca-hwf-p21-X'],
  ['bare20', '/tmp/orca-hwf-p20-'],
  ['dotdot20', '/tmp/orca-hwf-p20-../x'],
  ['semicolon20', '/tmp/orca-hwf-p20-a;id'],
  ['slash20', '/tmp/orca-hwf-p20-a/']
]

function report(side, label, status) {
  // ssh's own failure (or a spawn that never ran) is not a refusal by the guard.
  if (status === null || (side === 'remote' && status === SSH_OWN_FAILURE)) {
    console.log(`DRILL ${side} ${label} ERROR exit=${status}`)
    return
  }
  console.log(`DRILL ${side} ${label} ${status !== 0 ? 'REFUSED' : 'ACCEPTED'} exit=${status}`)
}

function runDriver(args) {
  return spawnSync(process.execPath, [driver, ...args], { encoding: 'utf8', timeout: 60_000 })
    .status
}

const script = readFileSync(path.join(here, 'hwf-two-host-disposable-root.sh'), 'utf8').replace(
  /\r\n/g,
  '\n'
)
const b64 = Buffer.from(script, 'utf8').toString('base64')

function runRemoteScript(root) {
  return spawnSync(
    'ssh',
    [
      '-o',
      'ConnectTimeout=10',
      '-o',
      'BatchMode=yes',
      carrierHost,
      `echo ${b64} | base64 -d | bash -s -- status '${root}'`
    ],
    { encoding: 'utf8', timeout: 60_000 }
  ).status
}

for (const [label, root] of badRoots) {
  report('driver', label, runDriver(['status', root]))
  report('remote', label, runRemoteScript(root))
}
report('remote', 'no-root', runRemoteScript('/tmp/orca-hwf-p16-NOPE0'))
report('remote', 'no-root17', runRemoteScript('/tmp/orca-hwf-p17-NOPE0'))
report('remote', 'no-root20', runRemoteScript('/tmp/orca-hwf-p20-NOPE0'))
report(
  'driver',
  'seed-p16-bad-root',
  runDriver(['seed-p16', '/tmp/orca-hwf-p18-X', '0123456789abcdef'])
)
report(
  'driver',
  'seed-p20-bad-root',
  runDriver(['seed-p20', '/tmp/orca-hwf-p21-X', '0123456789abcdef'])
)
report(
  'driver',
  'seed-p17-bad-root',
  runDriver(['seed-p17', '/tmp/orca-hwf-p18-X', '0123456789abcdef'])
)
report(
  'driver',
  'seed-p19-bad-root',
  runDriver(['seed-p19', '/tmp/orca-hwf-p19-X', '0123456789abcdef'])
)
report('driver', 'new-nonce', runDriver(['new-nonce']))
report('driver', 'new-root-p17', runDriver(['new-root', '--phase', '17']))
report('driver', 'new-root-p20', runDriver(['new-root', '--phase', '20']))
report(
  'driver',
  'seed-local-p16',
  runDriver([
    'seed-local-p16',
    '--nonce',
    '0123456789abcdef',
    '--dir',
    path.join(os.tmpdir(), `orca-hwf-p16-drill-${process.pid}`)
  ])
)
