#!/usr/bin/env node
// Bans `?? ALL_EXECUTION_HOSTS_SCOPE` (and `||`) across src/.
//
// Why a gate and not a type: normalizeExecutionHostScope returns null for a value
// that is not a host, which walks a caller to the refusal — but nothing stops a
// future caller coercing that null back to the all-hosts scope. That idiom turns a
// parse failure into the widest possible authority: it let a stale or malformed host
// id fan out and scan AI session transcripts on every paired SSH and runtime host,
// and it kept ai-vault's own refusal branch unreachable for that branch's whole life.
//
// Scoped to the constant on purpose. The bare string 'all' is overloaded in this
// repo — task presets, Linear scopes, sidebar grouping keys — and banning it produced
// 12 false positives, none an execution host. A gate that cries wolf gets switched off.
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const WIDENING_FALLBACK = /(\?\?|\|\|)\s*ALL_EXECUTION_HOSTS_SCOPE/
const SRC_ROOT = resolve(import.meta.dirname, '..', '..', 'src')
const MIN_FILES = 500
const MIN_CONSTANT_MENTIONS = 3

function collect(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
      continue
    }
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      collect(full, out)
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

// Positive control on the predicate itself: a detector that stopped detecting reports
// the same clean bill as one that works. The subject is synthetic, so this keeps
// working on the day no real file offends — a drill pinned to a real offender decays.
const SELF_TEST = [
  ['return normalizeExecutionHostId(v) ?? ALL_EXECUTION_HOSTS_SCOPE', true],
  ['const scope = parse(v) || ALL_EXECUTION_HOSTS_SCOPE', true],
  ["return resolved.kind === 'scope' ? resolved.scope : null", false],
  ['if (scope === ALL_EXECUTION_HOSTS_SCOPE) {', false],
  ["const preset = settings?.defaultTaskViewPreset ?? 'all'", false]
]
for (const [sample, expected] of SELF_TEST) {
  if (WIDENING_FALLBACK.test(sample) !== expected) {
    console.error(`SELF-TEST FAILED: expected ${expected} for ${JSON.stringify(sample)}`)
    process.exit(2)
  }
}

const files = collect(SRC_ROOT)
if (files.length < MIN_FILES) {
  console.error(`population floor: read ${files.length} files, expected >= ${MIN_FILES}.`)
  console.error('The sweep may have stopped seeing code — fix the walk, do not lower the floor.')
  process.exit(2)
}

const offenders = []
let mentions = 0
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  if (!text.includes('ALL_EXECUTION_HOSTS_SCOPE')) {
    continue
  }
  mentions += 1
  text.split('\n').forEach((line, index) => {
    if (WIDENING_FALLBACK.test(line)) {
      offenders.push(`${file.slice(SRC_ROOT.length + 1)}:${index + 1}: ${line.trim()}`)
    }
  })
}

if (mentions < MIN_CONSTANT_MENTIONS) {
  console.error(`only ${mentions} files mention ALL_EXECUTION_HOSTS_SCOPE; the sweep is blind.`)
  process.exit(2)
}

if (offenders.length > 0) {
  console.error('An unresolvable execution host scope must never widen to every host.')
  console.error('Refuse instead: resolveExecutionHostScope returns scope | absent | unresolvable.')
  for (const offender of offenders) {
    console.error(`  ${offender}`)
  }
  process.exit(1)
}

console.log(
  `PASS: ${files.length} files, ${mentions} reference the scope constant, 0 widening fallbacks`
)
