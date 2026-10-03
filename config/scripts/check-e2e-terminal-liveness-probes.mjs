#!/usr/bin/env node
/**
 * A spec may not add a substring terminal-liveness probe.
 *
 * "The terminal is alive" proven by a substring match on a marker the spec echoed is not proven:
 * the echoed command line itself contains the marker, and so does output that predates the action.
 * The replacement is the fresh-output family in tests/e2e/helpers/terminal-fresh-output-probes.ts
 * (per-call nonce, exact output line, read from the owning pane).
 *
 * Sites are found by what code does — a substring wait on a marker the same file echoed, or a
 * probe helper that echoes internally — never by searching for the fix. Existing sites are frozen
 * in config/e2e-terminal-liveness-substring-baseline.txt; the list may only shrink.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const E2E_DIR = path.join(REPO_ROOT, 'tests', 'e2e')
const BASELINE = path.join(REPO_ROOT, 'config', 'e2e-terminal-liveness-substring-baseline.txt')
const SKIP_DIRS = new Set(['node_modules', '.cross-version-checkouts'])

// Why a floor: a sweep that stopped seeing code reports zero sites, which reads as a paid-off debt.
// ~80% of the measured population (2026-10-03: 31 substring + 8 fresh = 39 sites, 386 specs).
// A smoke alarm, not a target; migration moves sites from substring to fresh and keeps the total.
const POPULATION_FLOOR = 31
const MIN_SPEC_FILES = 308

/** Helpers that write `echo <marker>` themselves and accept any occurrence of the marker. */
const SUBSTRING_PROBES = ['probeDirectWrite', 'probeKeyboardType', 'probeOwnershipRebuildRevival']
const FRESH_PROBES = [
  'probeDirectWriteOutput',
  'mainProbeDirectWriteOutput',
  'mainProbeTransportPasteOutput',
  'mainProbeOwnershipRebuildRevivalOutput',
  'probeKeyboardTypeOutput'
]
const WAIT_CALLEE = 'waitForTerminalOutput'
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/
const LITERAL = /^(['"`])([\s\S]*)\1$/
const TOKEN = /[A-Za-z][A-Za-z0-9_]+/g
const WAIT_CALL =
  /\bwaitForTerminalOutput\s*\(\s*[^,()]+?\s*,\s*('[^'\n]*'|"[^"\n]*"|`[^`]*`|[A-Za-z_$][\w$]*)/g

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const lineOf = (source, index) => source.slice(0, index).split('\n').length
const isDefinition = (source, index) =>
  /\bfunction\s+$/.test(source.slice(Math.max(0, index - 20), index))

function callSites(source, callee) {
  const sites = []
  for (const match of source.matchAll(new RegExp(`\\b${callee}\\s*\\(`, 'g'))) {
    if (!isDefinition(source, match.index)) {
      sites.push({ callee, line: lineOf(source, match.index) })
    }
  }
  return sites
}

/** Did this file echo the marker the wait reads? Quoting (`echo "${x}"`) does not change that. */
function fileEchoes(source, arg) {
  if (IDENTIFIER.test(arg)) {
    return new RegExp(`\\becho\\s+["']?\\$\\{${escapeRegExp(arg)}\\}`).test(source)
  }
  const literal = LITERAL.exec(arg)
  if (!literal) {
    return false
  }
  return [...literal[2].matchAll(TOKEN)].some(([token]) =>
    new RegExp(`\\becho\\s+["']?${token}(?![A-Za-z0-9_])`).test(source)
  )
}

export function findTerminalLivenessProbes(source) {
  const substring = SUBSTRING_PROBES.flatMap((callee) => callSites(source, callee))
  const fresh = FRESH_PROBES.flatMap((callee) => callSites(source, callee))
  for (const match of source.matchAll(WAIT_CALL)) {
    if (!isDefinition(source, match.index) && fileEchoes(source, match[1])) {
      substring.push({ callee: WAIT_CALLEE, line: lineOf(source, match.index) })
    }
  }
  const byLine = (a, b) => a.line - b.line
  return { substring: substring.sort(byLine), fresh: fresh.sort(byLine) }
}

/** `path<TAB>callee<TAB>count` → Map of `path<TAB>callee` → count. A malformed line throws. */
export function parseLivenessBaseline(text) {
  const entries = new Map()
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#')) {
      return
    }
    const parts = line.split('\t')
    if (parts.length !== 3 || !/^[1-9][0-9]*$/.test(parts[2])) {
      throw new Error(`baseline line ${index + 1} is not path<TAB>callee<TAB>count: ${raw}`)
    }
    entries.set(`${parts[0]}\t${parts[1]}`, Number(parts[2]))
  })
  return entries
}

export function diffLivenessBaseline(measured, baseline) {
  const growth = []
  const stale = []
  for (const [key, count] of measured) {
    const allowed = baseline.get(key) ?? 0
    if (count > allowed) {
      growth.push({ key, measured: count, baseline: allowed })
    }
  }
  for (const [key, allowed] of baseline) {
    const count = measured.get(key) ?? 0
    if (count < allowed) {
      stale.push({ key, measured: count, baseline: allowed })
    }
  }
  return { growth, stale }
}

/** Keeps only keys still measured, each at min(measured, baseline): never adds, never raises. */
export function pruneLivenessBaseline(measured, baseline) {
  const pruned = new Map()
  for (const [key, allowed] of baseline) {
    const count = Math.min(measured.get(key) ?? 0, allowed)
    if (count > 0) {
      pruned.set(key, count)
    }
  }
  return pruned
}

export function serializeLivenessBaseline(entries) {
  const header = [
    '# Substring terminal-liveness probe sites in tests/e2e: path<TAB>callee<TAB>count.',
    '# Shrink-only: migrate a site to a fresh-output probe (probeDirectWriteOutput, ...), then prune.',
    '# Prune with: node config/scripts/check-e2e-terminal-liveness-probes.mjs --prune',
    '# Never add an entry or raise a count to get green; new liveness probes must use fresh output.'
  ]
  const lines = [...entries]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, n]) => `${key}\t${n}`)
  return `${[...header, ...lines].join('\n')}\n`
}

function selfTest() {
  // Synthetic subjects: a red pinned to a real spec would decay the moment that spec is migrated.
  const RED = [
    [
      'echo-backed wait',
      'await execInTerminal(page, id, `echo ${marker}`)\nawait waitForTerminalOutput(page, marker)'
    ],
    ['echo-internal probe', "await probeDirectWrite(page, id, 'X_OK')"]
  ]
  const GREEN = [
    ['fresh probe', "await probeDirectWriteOutput(page, id, 'X')", 1],
    ['content check on text never echoed', "await waitForTerminalOutput(page, 'Welcome')", 0],
    ['helper definition', 'export async function probeDirectWrite(page) {}', 0]
  ]
  const failures = []
  for (const [name, source] of RED) {
    if (findTerminalLivenessProbes(source).substring.length !== 1) {
      failures.push(`detector did not flag the synthetic ${name}`)
    }
  }
  for (const [name, source, fresh] of GREEN) {
    const found = findTerminalLivenessProbes(source)
    if (found.substring.length !== 0 || found.fresh.length !== fresh) {
      failures.push(`detector misread the ${name}: ${JSON.stringify(found)}`)
    }
  }
  return failures
}

function listTsFiles(dir) {
  const found = []
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) {
      continue
    }
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      found.push(...listTsFiles(full))
    } else if (entry.endsWith('.ts')) {
      found.push(full)
    }
  }
  return found
}

function sweep() {
  const measured = new Map()
  let substring = 0
  let fresh = 0
  let specFiles = 0
  for (const file of listTsFiles(E2E_DIR)) {
    if (file.endsWith('.spec.ts')) {
      specFiles += 1
    }
    const found = findTerminalLivenessProbes(readFileSync(file, 'utf8'))
    fresh += found.fresh.length
    substring += found.substring.length
    const rel = path.relative(REPO_ROOT, file).replaceAll('\\', '/')
    for (const site of found.substring) {
      const key = `${rel}\t${site.callee}`
      measured.set(key, (measured.get(key) ?? 0) + 1)
    }
  }
  return { measured, substring, fresh, specFiles }
}

const fail = (code, lines) => {
  for (const line of lines) {
    console.error(line)
  }
  process.exit(code)
}

const describeEntry = ({ key, measured, baseline }) =>
  `      ${key.replace('\t', '  ')}  (measured ${measured}, baseline ${baseline})`

function main() {
  const NAME = 'check-e2e-terminal-liveness-probes'
  const selfTestFailures = selfTest()
  if (selfTestFailures.length > 0) {
    // A detector that stopped detecting reports the same green as one that works.
    fail(2, [
      `❌  ${NAME}: the detector itself is broken.`,
      ...selfTestFailures.map((f) => `      ${f}`)
    ])
  }

  const { measured, substring, fresh, specFiles } = sweep()
  if (substring + fresh < POPULATION_FLOOR || specFiles < MIN_SPEC_FILES) {
    fail(2, [
      `❌  ${NAME}: swept ${specFiles} spec files / ${substring + fresh} liveness sites, expected at ` +
        `least ${MIN_SPEC_FILES} / ${POPULATION_FLOOR}. The sweep may have stopped seeing code.`
    ])
  }

  const rel = path.relative(REPO_ROOT, BASELINE)
  if (process.argv.includes('--init')) {
    if (existsSync(BASELINE)) {
      fail(1, [
        `❌  ${NAME}: --init refused, ${rel} already exists. The baseline only shrinks (--prune).`
      ])
    }
    writeFileSync(BASELINE, serializeLivenessBaseline(measured), 'utf8')
    console.error(`✅  ${NAME}: wrote ${measured.size} entries (${substring} sites) to ${rel}.`)
    return
  }
  if (!existsSync(BASELINE)) {
    fail(1, [`❌  ${NAME}: baseline missing at ${rel}.`])
  }
  let baseline
  try {
    baseline = parseLivenessBaseline(readFileSync(BASELINE, 'utf8'))
  } catch (error) {
    fail(1, [`❌  ${NAME}: ${error.message}`])
  }

  if (process.argv.includes('--prune')) {
    const pruned = pruneLivenessBaseline(measured, baseline)
    writeFileSync(BASELINE, serializeLivenessBaseline(pruned), 'utf8')
    console.error(`✅  ${NAME}: pruned ${rel} from ${baseline.size} to ${pruned.size} entries.`)
    return
  }

  const { growth, stale } = diffLivenessBaseline(measured, baseline)
  const failures = []
  if (growth.length > 0) {
    failures.push(
      `❌  ${growth.length} new substring terminal-liveness probe site(s):\n`,
      ...growth.map(describeEntry),
      '\n    A substring match passes on the echoed command and on output older than the action.',
      '    Prove liveness with a fresh-output probe from tests/e2e/helpers/terminal-fresh-output-probes.ts',
      `    (${FRESH_PROBES.join(', ')}).`,
      '    Do not add the site to the baseline: it only shrinks.\n'
    )
  }
  if (stale.length > 0) {
    failures.push(
      `❌  ${stale.length} baseline entr(ies) above what the tree holds — the debt shrank; prune with --prune:\n`,
      ...stale.map(describeEntry),
      `\n    node config/scripts/${NAME}.mjs --prune\n`
    )
  }
  if (failures.length > 0) {
    fail(1, failures)
  }
  console.error(
    `✅  ${NAME}: ${substring} substring site(s) frozen in ${baseline.size} entries, ${fresh} fresh-output ` +
      `site(s), ${specFiles} spec files (floor ${POPULATION_FLOOR} sites / ${MIN_SPEC_FILES} specs).`
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main()
}
