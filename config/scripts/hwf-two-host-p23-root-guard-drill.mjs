#!/usr/bin/env node
// Linux GEX44 harness verb: drills the phase-23 root guard of hwf-two-host-disposable-root.sh with no ssh and no second host.
// Only the `status` verb runs, and only against roots that either fail the guard or do not exist, so nothing is created.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_SCRIPT = path.join(import.meta.dirname, 'hwf-two-host-disposable-root.sh')
const REFUSED_EXIT = 2
// Measured on GEX44: a guard-passing root that does not exist answers `REFUSED no-root=<root>`, exit 3.
const MISSING_ROOT_EXIT = 3

function freshValidRoot() {
  for (;;) {
    const root = `/tmp/orca-hwf-p23-drill${randomBytes(6).toString('hex')}`
    if (!existsSync(root)) {
      return root
    }
  }
}

function refused(name, root) {
  return { name, root, exit: REFUSED_EXIT, firstLine: `REFUSED root=${root}` }
}

export function buildRows() {
  const control = freshValidRoot()
  return [
    // Positive control: the guard lets this through, so a guard that refuses everything fails here.
    {
      name: 'valid-root-control',
      root: control,
      exit: MISSING_ROOT_EXIT,
      firstLine: `REFUSED no-root=${control}`
    },
    refused('empty-suffix', '/tmp/orca-hwf-p23-'),
    refused('shell-metacharacter', '/tmp/orca-hwf-p23-a;id'),
    refused('space', '/tmp/orca-hwf-p23-a b'),
    refused('command-substitution', '/tmp/orca-hwf-p23-$(id)'),
    refused('traversal', '/tmp/orca-hwf-p23-../x'),
    refused('other-phase-prefix', '/tmp/orca-hwf-p99-abc'),
    refused('filesystem-root', '/'),
    refused('home-directory', os.homedir()),
    refused('empty-string', ''),
    refused('relative-name', 'orca-hwf-p23-abc'),
    refused('foreign-directory', '/var/tmp/orca-hwf-p23-abc')
  ]
}

function listP23Roots() {
  return readdirSync('/tmp')
    .filter((name) => name.startsWith('orca-hwf-p23-'))
    .sort()
}

function runStatus(scriptPath, root) {
  const result = spawnSync('bash', [scriptPath, 'status', root], {
    encoding: 'utf8',
    timeout: 30_000,
    cwd: os.tmpdir()
  })
  return { status: result.status, firstLine: (result.stdout ?? '').split('\n')[0] ?? '' }
}

export function runDrill(scriptPath = DEFAULT_SCRIPT) {
  const rootsBefore = listP23Roots()
  const lines = []
  let passed = 0
  const rows = buildRows()
  for (const row of rows) {
    const actual = runStatus(scriptPath, row.root)
    const ok = actual.status === row.exit && actual.firstLine === row.firstLine
    passed += ok ? 1 : 0
    lines.push(`P23_ROOT_GUARD ${row.name} ${ok ? 'PASS' : 'FAIL'} exit=${actual.status}`)
  }
  const untouched = JSON.stringify(listP23Roots()) === JSON.stringify(rootsBefore)
  passed += untouched ? 1 : 0
  lines.push(`P23_ROOT_GUARD nothing-created ${untouched ? 'PASS' : 'FAIL'} exit=none`)
  const total = rows.length + 1
  lines.push(`P23_ROOT_GUARD pass=${passed}/${total}`)
  return { lines, passed, total }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { lines, passed, total } = runDrill(process.argv[2])
  console.log(lines.join('\n'))
  process.exit(passed === total ? 0 : 1)
}
