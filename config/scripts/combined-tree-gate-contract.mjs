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
//
// Exit: 0 GREEN (plan: printed), 1 RED, 2 no verdict (unreadable or invalid input).

import { readFileSync } from 'node:fs'
import process from 'node:process'
import { parse, printParseErrorCode } from 'jsonc-parser'
import { isEntryPoint } from './check-mobile-capability-aperture.mjs'

export const MANIFEST_SCHEMA = 'combined-tree-gate/1'

// Why: manifest tokens become argv and plan-line words in bash; no whitespace or shell metacharacter.
const TOKEN = /^[A-Za-z0-9_./@:=+,-]+$/
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/
// Why: a spec name becomes the path tests/e2e/<name>.spec.ts, so no slash or dot-dot.
const SPEC_NAME = /^[a-z0-9][a-z0-9-]*$/
// Why: a group name is upper-cased into the UNIT_<GROUP>_REGRESSIONS token.
const GROUP_NAME = /^[a-z][a-z0-9]*$/
const GATE_NAME = /^[a-z][a-z0-9-]*$/
const COMMIT = /^[0-9a-f]{7,40}$/

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isCount = (v) => Number.isInteger(v) && v >= 1

function checkKeys(entry, allowed, where, violations) {
  for (const key of Object.keys(entry)) {
    if (!allowed.includes(key)) {
      violations.push(`${where}: unknown key ${key}`)
    }
  }
}

function checkNamedList(list, kind, nameRe, allowed, checkEntry, violations) {
  if (!Array.isArray(list) || list.length === 0) {
    violations.push(`${kind} must be a non-empty array`)
    return
  }
  const seen = new Set()
  list.forEach((entry, i) => {
    if (!isObject(entry)) {
      violations.push(`${kind}[${i}] is not an object`)
      return
    }
    const where = `${kind} ${typeof entry.name === 'string' ? entry.name : `[${i}]`}`
    if (typeof entry.name !== 'string' || !nameRe.test(entry.name)) {
      violations.push(`${kind}[${i}] name ${JSON.stringify(entry.name)} must match ${nameRe}`)
    } else if (seen.has(entry.name)) {
      violations.push(`${kind}: duplicate name ${entry.name}`)
    } else {
      seen.add(entry.name)
    }
    checkKeys(entry, allowed, where, violations)
    checkEntry(entry, where)
  })
}

function checkTokens(value, where, violations) {
  if (!Array.isArray(value) || value.length === 0) {
    violations.push(`${where} must be a non-empty array of tokens`)
    return
  }
  for (const token of value) {
    if (typeof token !== 'string' || !TOKEN.test(token)) {
      violations.push(`${where}: token ${JSON.stringify(token)} must match ${TOKEN}`)
    }
  }
}

function checkEnv(m, violations) {
  const specEnv = m.specEnv ?? {}
  if (!isObject(specEnv)) {
    violations.push('specEnv must be an object')
  } else {
    for (const [name, value] of Object.entries(specEnv)) {
      if (!ENV_NAME.test(name)) {
        violations.push(`specEnv name ${name} must match ${ENV_NAME}`)
      }
      if (typeof value !== 'string' || !TOKEN.test(value)) {
        violations.push(`specEnv ${name}: value ${JSON.stringify(value)} must match ${TOKEN}`)
      }
    }
  }
  const required = m.requiredEnv ?? []
  if (!Array.isArray(required)) {
    violations.push('requiredEnv must be an array')
    return
  }
  required.forEach((entry, i) => {
    if (!isObject(entry) || typeof entry.name !== 'string' || !ENV_NAME.test(entry.name)) {
      violations.push(`requiredEnv[${i}] needs a name matching ${ENV_NAME}`)
      return
    }
    checkKeys(entry, ['name', 'pathList'], `requiredEnv ${entry.name}`, violations)
    if (entry.pathList !== undefined && typeof entry.pathList !== 'boolean') {
      violations.push(`requiredEnv ${entry.name}: pathList must be a boolean`)
    }
  })
}

/** Parses and validates the manifest text; throws one Error naming every violation. */
export function loadManifest(rawText) {
  const errors = []
  const m = parse(rawText, errors, { allowTrailingComma: true })
  if (errors.length > 0) {
    const where = errors.map((e) => `${printParseErrorCode(e.error)} at offset ${e.offset}`)
    throw new Error(`manifest is not valid JSONC: ${where.join('; ')}`)
  }
  if (!isObject(m)) {
    throw new Error('manifest invalid: the top level is not an object')
  }
  const violations = []
  const top = [
    'schema',
    'changedFilesBase',
    'specEnv',
    'requiredEnv',
    'specs',
    'unitGroups',
    'staticGates'
  ]
  checkKeys(m, top, 'manifest', violations)
  if (m.schema !== MANIFEST_SCHEMA) {
    violations.push(`schema must be ${MANIFEST_SCHEMA}, got ${JSON.stringify(m.schema)}`)
  }
  if (typeof m.changedFilesBase !== 'string' || !COMMIT.test(m.changedFilesBase)) {
    violations.push(
      `changedFilesBase must be a 7-40 hex commit, got ${JSON.stringify(m.changedFilesBase)}`
    )
  }
  checkEnv(m, violations)
  checkNamedList(
    m.specs,
    'specs',
    SPEC_NAME,
    ['name', 'minPassed'],
    (s, where) => {
      if (!isCount(s.minPassed)) {
        violations.push(`${where}: minPassed must be an integer >= 1`)
      }
    },
    violations
  )
  const groupKeys = ['name', 'paths', 'minPassedFiles', 'regressionDiff', 'knownFailures']
  checkNamedList(
    m.unitGroups,
    'unitGroups',
    GROUP_NAME,
    groupKeys,
    (g, where) => {
      checkTokens(g.paths, `${where} paths`, violations)
      if (!isCount(g.minPassedFiles)) {
        violations.push(`${where}: minPassedFiles must be an integer >= 1`)
      }
      if (g.regressionDiff !== undefined && typeof g.regressionDiff !== 'boolean') {
        violations.push(`${where}: regressionDiff must be a boolean`)
      }
      if (g.knownFailures !== undefined) {
        const ok =
          Array.isArray(g.knownFailures) &&
          g.knownFailures.every((f) => typeof f === 'string' && f.trim())
        if (!ok || g.regressionDiff !== true) {
          violations.push(
            `${where}: knownFailures must be non-empty strings in a regressionDiff group`
          )
        }
      }
    },
    violations
  )
  checkNamedList(
    m.staticGates,
    'staticGates',
    GATE_NAME,
    ['name', 'argv', 'changedFiles'],
    (g, where) => {
      checkTokens(g.argv, `${where} argv`, violations)
      if (g.changedFiles !== undefined && typeof g.changedFiles !== 'boolean') {
        violations.push(`${where}: changedFiles must be a boolean`)
      }
    },
    violations
  )
  if (violations.length > 0) {
    throw new Error(`manifest invalid: ${violations.join('; ')}`)
  }
  return {
    schema: m.schema,
    changedFilesBase: m.changedFilesBase,
    specEnv: { ...m.specEnv },
    requiredEnv: (m.requiredEnv ?? []).map((e) => ({
      name: e.name,
      pathList: e.pathList === true
    })),
    specs: m.specs.map((s) => ({ name: s.name, minPassed: s.minPassed })),
    unitGroups: m.unitGroups.map((g) => ({
      name: g.name,
      paths: [...g.paths],
      minPassedFiles: g.minPassedFiles,
      regressionDiff: g.regressionDiff === true,
      knownFailures: [...(g.knownFailures ?? [])]
    })),
    staticGates: m.staticGates.map((g) => ({
      name: g.name,
      argv: [...g.argv],
      changedFiles: g.changedFiles === true
    }))
  }
}

const flag = (b) => (b ? '1' : '0')

/** The plan as space-separated lines; the runner reads them with `read -r -a`, never as code. */
export function planLines(manifest) {
  return [
    `PLAN_BASE ${manifest.changedFilesBase}`,
    ...Object.entries(manifest.specEnv).map(([name, value]) => `PLAN_ENV ${name} ${value}`),
    ...manifest.requiredEnv.map((e) => `PLAN_REQUIRE_ENV ${e.name} ${flag(e.pathList)}`),
    ...manifest.specs.map((s) => `PLAN_SPEC ${s.name} ${s.minPassed}`),
    ...manifest.unitGroups.map(
      (g) =>
        `PLAN_UNIT ${g.name} ${g.minPassedFiles} ${flag(g.regressionDiff)} ${g.paths.join(' ')}`
    ),
    ...manifest.staticGates.map(
      (g) => `PLAN_GATE ${g.name} ${flag(g.changedFiles)} ${g.argv.join(' ')}`
    ),
    `PLAN_COUNTS specs=${manifest.specs.length} units=${manifest.unitGroups.length} gates=${manifest.staticGates.length}`
  ]
}

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
  verdict: verdictCommand
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
