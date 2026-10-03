#!/usr/bin/env node
// Combined-tree gate contract: the manifest, the summary-line grammar and the verdict.
//
// The rule this encodes: a verdict judged by count alone lets a skipped or duplicated spec pass.
// Phase 1's tip verdict counted 14 SPEC_RESULT lines and read exit=0 as GREEN, so mission-brief
// without MISSION_BRIEF_REPOS ("2 skipped", exit 0) or one spec run twice while another was dropped
// read GREEN. Here every spec, unit group and gate in config/combined-tree-gate.jsonc is required by
// NAME, exactly once, and every spec and unit group by a passed floor.
//
//   node config/scripts/combined-tree-gate-contract.mjs plan --manifest <path>
//   node config/scripts/combined-tree-gate-contract.mjs verdict --manifest <path> --summary <path>
//   node config/scripts/combined-tree-gate-contract.mjs spec-result --name <n> --exit <rc> --log <path>
//        [--head-moved <sha9>]
//   node config/scripts/combined-tree-gate-contract.mjs unit-result --manifest <m> --group <g> --exit <rc>
//        --log <path> --json <path> --failures-out <path>
//   node config/scripts/combined-tree-gate-contract.mjs gate-result --name <n> --exit <rc> --log <path>
//        [--no-changed-files]
//
// The *-result commands mint one summary line each (P1 grammar, byte-compatible) and always print it.
// Exit: 0 GREEN or printed, 1 RED, 2 no verdict (unreadable or invalid input) or usage error.

import { readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { isEntryPoint } from './check-mobile-capability-aperture.mjs'
import { loadManifest, planLines } from './combined-tree-gate-manifest.mjs'

export { MANIFEST_SCHEMA, loadManifest, planLines } from './combined-tree-gate-manifest.mjs'

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

export const regressionsToken = (group) => `UNIT_${group.toUpperCase()}_REGRESSIONS`

/** Lines whose first word is `kind`, grouped by their second word. */
function linesByName(lines, kind) {
  const byName = new Map()
  for (const line of lines) {
    const words = line.split(' ')
    if (words[0] !== kind || !words[1]) {
      continue
    }
    byName.set(words[1], [...(byName.get(words[1]) ?? []), line])
  }
  return byName
}

/** Exactly one line per expected name; reports MISSING/DUPLICATE/UNEXPECTED and judges the rest. */
function judgeNamed(byName, kind, names, judge, fail) {
  for (const name of names) {
    const found = byName.get(name) ?? []
    if (found.length === 0) {
      fail(`MISSING ${kind} ${name}`)
    } else if (found.length > 1) {
      fail(`DUPLICATE ${kind} ${name}`)
    } else {
      judge(name, found[0])
    }
  }
  for (const name of byName.keys()) {
    if (!names.includes(name)) {
      fail(`UNEXPECTED ${kind} ${name}`)
    }
  }
}

const SPEC_COUNT = /(\d+) (passed|failed|skipped|flaky|did not run|interrupted)/g

/** Playwright list-reporter counts from a SPEC_RESULT counts segment. */
export function parseSpecCounts(segment) {
  const counts = {}
  for (const m of segment.matchAll(SPEC_COUNT)) {
    counts[m[2]] = (counts[m[2]] ?? 0) + Number(m[1])
  }
  return counts
}

function judgeHeader(lines, fail) {
  let head = null
  const heads = lines.filter((l) => l.startsWith('HEAD='))
  if (heads.length !== 1) {
    fail(heads.length === 0 ? 'MISSING HEAD' : 'DUPLICATE HEAD')
  } else {
    const m = /^HEAD=([0-9a-f]{40}) dirty=0$/.exec(heads[0])
    if (m) {
      head = m[1]
    } else {
      fail(heads[0])
    }
  }
  const mismatch = lines.find((l) => l.startsWith('LOCK_MISMATCH'))
  if (mismatch) {
    fail(mismatch)
  } else if (!lines.some((l) => /^LOCK_OK \S+$/.test(l))) {
    fail('MISSING LOCK_OK')
  }
  const builds = lines.filter((l) => l.startsWith('BUILD_real_EXIT='))
  if (builds.length !== 1) {
    fail(builds.length === 0 ? 'MISSING BUILD_real_EXIT' : 'DUPLICATE BUILD_real_EXIT')
  } else {
    // Why: a green build of another revision, or of a dirty tree, says nothing about this HEAD.
    const m = /^BUILD_real_EXIT=0 head=([0-9a-f]{9}) dirty=0$/.exec(builds[0])
    if (!m || (head && !head.startsWith(m[1]))) {
      fail(builds[0])
    }
  }
  return head
}

function judgeSpecs(lines, manifest, fail) {
  const floors = new Map(manifest.specs.map((s) => [s.name, s.minPassed]))
  judgeNamed(
    linesByName(lines, 'SPEC_RESULT'),
    'SPEC_RESULT',
    [...floors.keys()],
    (name, line) => {
      const m = /^SPEC_RESULT \S+ label=(\S+) exit=(\S+) verdict=(\S+)(.*)$/.exec(line)
      const counts = m ? parseSpecCounts(m[4]) : {}
      const unclean = ['failed', 'flaky', 'did not run', 'interrupted'].some(
        (k) => (counts[k] ?? 0) > 0
      )
      if (!m || m[1] !== 'real' || m[2] !== '0' || m[3] !== 'PRODUCT_RUN' || unclean) {
        fail(line)
        return
      }
      // Why: an all-skipped spec exits 0 with "N skipped"; only passed tests are evidence.
      const passed = counts.passed ?? 0
      if (passed < floors.get(name)) {
        fail(`FLOOR SPEC_RESULT ${name} passed=${passed} min=${floors.get(name)}`)
      }
    },
    fail
  )
}

function judgeUnits(lines, manifest, fail) {
  const groups = new Map(manifest.unitGroups.map((g) => [g.name, g]))
  judgeNamed(
    linesByName(lines, 'UNIT'),
    'UNIT',
    [...groups.keys()],
    (name, line) => {
      const g = groups.get(name)
      const m = /^UNIT \S+ exit=(\S+)(.*)$/.exec(line)
      // Why: only a regression-diffed group with a recorded baseline may fail; with none, exit decides.
      const tolerated = g.regressionDiff && g.knownFailures.length > 0
      if (!m || (m[1] !== '0' && !tolerated)) {
        fail(line)
      }
      const files = m ? /Test Files ([^;]*)/.exec(m[2]) : null
      const passed = files ? /(\d+) passed/.exec(files[1]) : null
      if (!passed) {
        fail(line)
      } else if (Number(passed[1]) < g.minPassedFiles) {
        fail(`FLOOR UNIT ${name} passedFiles=${passed[1]} min=${g.minPassedFiles}`)
      }
    },
    fail
  )
  const regressionGroups = manifest.unitGroups.filter((g) => g.regressionDiff)
  for (const g of regressionGroups) {
    const token = regressionsToken(g.name)
    const found = lines.filter((l) => l === token || l.startsWith(`${token} `))
    if (found.length !== 1) {
      fail(`${found.length === 0 ? 'MISSING' : 'DUPLICATE'} ${token} ${g.name}`)
    } else if (found[0] !== `${token} 0`) {
      fail(found[0])
    }
  }
  const expected = new Set(regressionGroups.map((g) => regressionsToken(g.name)))
  for (const line of lines) {
    const token = line.split(' ')[0]
    if (/^UNIT_\S+_REGRESSIONS$/.test(token) && !expected.has(token)) {
      fail(`UNEXPECTED ${token}`)
    }
  }
}

function judgeGates(lines, manifest, fail) {
  const names = manifest.staticGates.map((g) => g.name)
  judgeNamed(
    linesByName(lines, 'GATE'),
    'GATE',
    names,
    (_name, line) => {
      if (line.split(' ')[2] !== 'exit=0') {
        fail(line)
      }
    },
    fail
  )
}

/** Judges summary.txt against the manifest by name and count. Only a complete summary is GREEN. */
export function evaluateSummary(summaryText, manifest) {
  const lines = summaryText.split(/\r?\n/)
  const failures = []
  const fail = (reason) => {
    if (!failures.includes(reason)) {
      failures.push(reason)
    }
  }
  const head = judgeHeader(lines, fail)
  judgeSpecs(lines, manifest, fail)
  judgeUnits(lines, manifest, fail)
  judgeGates(lines, manifest, fail)
  return { verdict: failures.length === 0 ? 'GREEN' : 'RED', head, failures }
}

// Why strip ANSI: the list reporter colours the counts line, which hid it from P1's count grep.
const ANSI_SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
const stripAnsi = (text) => text.replace(ANSI_SGR, '')
const squeeze = (line) => line.replace(/ +/g, ' ')
const logLines = (log) =>
  stripAnsi(log)
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
const exitToken = (exit) => (/^\d+$/.test(String(exit ?? '')) ? String(exit) : 'unknown')
const SPEC_COUNT_LINE = /^\s+[0-9]+ (passed|failed|skipped|flaky|did not run|interrupted)/

/** One SPEC_RESULT line; `log` is the Playwright log text, or null when it could not be read. */
export function mintSpecResult({ name, exit, log, headMoved }) {
  if (headMoved) {
    return `SPEC_RESULT ${name} label=real exit=99 verdict=HEAD_MOVED from=${headMoved}`
  }
  const text = log ?? ''
  const sum = logLines(text)
    .filter((l) => SPEC_COUNT_LINE.test(l))
    .map((l) => `${squeeze(l)};`)
    .join('')
  let verdict = 'PRODUCT_RUN'
  // Why: a spec tagged for the other project reads "No tests found" and exits like a failure.
  if (text.includes('No tests found')) {
    verdict = 'HARNESS_FAILED'
  } else if (!sum) {
    verdict = 'NO_RESULT'
  }
  return `SPEC_RESULT ${name} label=real exit=${exitToken(exit)} verdict=${verdict} ${sum}`
}

/** One UNIT line from a vitest default-reporter log (null when unreadable: no counts, so RED). */
export function mintUnitResult({ group, exit, log }) {
  const sum = logLines(log ?? '')
    .filter((l) => /Test Files|Tests {2}/.test(l))
    .map((l) => `${squeeze(l)};`)
    .join('')
  return `UNIT ${group} exit=${exitToken(exit)} ${sum}`
}

/** Failed assertions (plus assertion-less failed files) from vitest JSON, minus known failures. */
export function unitRegressions(group, jsonText, knownFailures) {
  const token = regressionsToken(group)
  let data
  try {
    data = JSON.parse(jsonText ?? '')
  } catch (error) {
    return {
      line: `${token} unknown JSON unreadable: ${oneLine(error.message)}`,
      failuresText: 'UNKNOWN\n'
    }
  }
  // Why: a report without results says nothing ran; reading that as 0 regressions is a pass by absence.
  if (!isObject(data) || !Array.isArray(data.testResults)) {
    return { line: `${token} unknown JSON has no testResults array`, failuresText: 'UNKNOWN\n' }
  }
  const failed = data.testResults
    .flatMap((f) => f?.assertionResults ?? [])
    .filter((a) => a?.status === 'failed')
    .map((a) => a.fullName)
    .sort()
  for (const f of data.testResults) {
    if (f?.status === 'failed' && !f.assertionResults?.length) {
      failed.push(`FILE_FAILED ${f.name ?? '?'}`)
    }
  }
  const known = new Set(knownFailures)
  const regressions = failed.filter((name) => !known.has(name))
  return {
    line: `${token} ${regressions.length}`,
    failuresText: failed.length > 0 ? `${failed.join('\n')}\n` : 'NONE\n'
  }
}

/** One GATE line: the last non-empty log line, ANSI-stripped, at most 160 characters. */
export function mintGateResult({ name, exit, log, noChangedFiles = false }) {
  if (noChangedFiles) {
    return `GATE ${name} exit=0 no changed files`
  }
  if (log === null || log === undefined) {
    // Why: an unreadable log proves nothing ran, so the exit token must not read as a pass.
    return `GATE ${name} exit=unknown rc=${exitToken(exit)} log unreadable`
  }
  const tail = logLines(log).findLast((l) => l.trim()) ?? ''
  return `GATE ${name} exit=${exitToken(exit)} ${[...tail].slice(0, 160).join('')}`
}

const readOrNull = (path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

const oneLine = (text) => String(text).replace(/\s*\n\s*/g, '; ')

function option(args, name) {
  const i = args.indexOf(name)
  return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined
}

function readManifest(args) {
  const path = option(args, '--manifest')
  if (!path) {
    throw new Error('missing --manifest <path>')
  }
  return loadManifest(readFileSync(path, 'utf8'))
}

function verdictCommand(args) {
  let manifest
  let summary
  try {
    manifest = readManifest(args)
    const path = option(args, '--summary')
    if (!path) {
      throw new Error('missing --summary <path>')
    }
    summary = readFileSync(path, 'utf8')
  } catch (error) {
    console.log(`TIP_VERDICT NO_VERDICT ${oneLine(error.message)}`)
    return 2
  }
  const result = evaluateSummary(summary, manifest)
  for (const reason of result.failures) {
    console.log(`VERDICT_FAILURE ${reason}`)
  }
  if (result.verdict === 'GREEN') {
    console.log(`TIP_VERDICT GREEN head=${result.head}`)
    return 0
  }
  console.log(`TIP_VERDICT RED ${result.failures[0]}`)
  return 1
}

function unitResultCommand(args) {
  const group = option(args, '--group')
  if (!group) {
    console.error('unit-result needs --group <group>')
    return 2
  }
  const exit = option(args, '--exit')
  console.log(mintUnitResult({ group, exit, log: readOrNull(option(args, '--log') ?? '') }))
  let manifestGroup
  try {
    manifestGroup = readManifest(args).unitGroups.find((g) => g.name === group)
  } catch (error) {
    console.log(`${regressionsToken(group)} unknown manifest: ${oneLine(error.message)}`)
    return 2
  }
  if (!manifestGroup?.regressionDiff) {
    return 0
  }
  const result = unitRegressions(
    group,
    readOrNull(option(args, '--json') ?? ''),
    manifestGroup.knownFailures
  )
  const out = option(args, '--failures-out')
  if (out) {
    writeFileSync(out, result.failuresText)
  }
  console.log(result.line)
  return 0
}

const COMMANDS = {
  plan(args) {
    try {
      console.log(planLines(readManifest(args)).join('\n'))
      return 0
    } catch (error) {
      console.error(`REFUSED_MANIFEST ${oneLine(error.message)}`)
      return 2
    }
  },
  verdict: verdictCommand,
  'spec-result'(args) {
    const name = option(args, '--name')
    if (!name) {
      console.error('spec-result needs --name <spec>')
      return 2
    }
    const headMoved = option(args, '--head-moved')
    const log = headMoved ? null : readOrNull(option(args, '--log') ?? '')
    console.log(mintSpecResult({ name, exit: option(args, '--exit'), log, headMoved }))
    return 0
  },
  'unit-result': unitResultCommand,
  'gate-result'(args) {
    const name = option(args, '--name')
    if (!name) {
      console.error('gate-result needs --name <gate>')
      return 2
    }
    const noChangedFiles = args.includes('--no-changed-files')
    const log = noChangedFiles ? null : readOrNull(option(args, '--log') ?? '')
    console.log(mintGateResult({ name, exit: option(args, '--exit'), log, noChangedFiles }))
    return 0
  }
}

export function runCli(argv) {
  const [command, ...args] = argv
  const run = COMMANDS[command]
  if (!run) {
    console.error(
      `usage: combined-tree-gate-contract.mjs <${Object.keys(COMMANDS).join('|')}> [options]`
    )
    return 2
  }
  return run(args)
}

if (isEntryPoint(process.argv[1], import.meta.filename)) {
  process.exitCode = runCli(process.argv.slice(2))
}
