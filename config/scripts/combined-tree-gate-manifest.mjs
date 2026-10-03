// Combined-tree gate manifest: schema validation and the plan lines the runner reads.
// Split from combined-tree-gate-contract.mjs, which judges and mints; this file only describes a run.

import { parse, printParseErrorCode } from 'jsonc-parser'

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

// Why: the runner is bash; a manifest name must not shadow its variables or the process-wide ones.
const RESERVED_ENV = new Set(
  `_ PATH HOME IFS PWD OLDPWD SHELL USER LANG SKIP_BUILD VITE_EXPOSE_STORE TREE CONTRACT MANIFEST
  MANIFEST_SRC MODE SUMMARY LABEL EXPECT SNAP BASE HEAD DIRTY LOCK RUN S SPECS UNITS GATES PLAN CHANGED`.split(
    /\s+/
  )
)
const RESERVED_ENV_PREFIXES = ['CTG_', 'LD_', 'DYLD_', 'BASH', 'GIT_', 'NODE_']
const isReservedEnv = (name) =>
  RESERVED_ENV.has(name) || RESERVED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))

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
      } else if (isReservedEnv(name)) {
        violations.push(`specEnv name ${name} is reserved (runner or process-wide variable)`)
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
    if (isReservedEnv(entry.name)) {
      violations.push(`requiredEnv ${entry.name} is reserved (runner or process-wide variable)`)
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
