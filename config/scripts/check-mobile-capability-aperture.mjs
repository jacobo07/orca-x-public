// Ratchets the desktop→mobile capability aperture.
//
// Why this exists beside check-variant-parity.mjs: that gate disciplines the 19 capabilities
// somebody thought to ask about. It cannot see the surface nobody entered, and a registry whose
// unknown list is empty reads identically whether the estate is in parity or nobody looked. This
// gate supplies the denominator — every RPC method the host serves — and refuses a NEW host-only
// method landing without a decision about mobile.
//
// The population is enumerated structurally from `defineMethod({ name: ... })` declarations. It is
// never derived from the allowlist: searching for a gate finds the members that have it, which is
// the opposite of the question.

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')

export const DEFAULT_METHODS_DIR = path.join(REPO_ROOT, 'src', 'main', 'runtime', 'rpc', 'methods')
export const DEFAULT_RPC_FILE = path.join(REPO_ROOT, 'src', 'main', 'runtime', 'runtime-rpc.ts')
export const DEFAULT_BASELINE = path.join(
  REPO_ROOT,
  'config',
  'mobile-capability-aperture-baseline.txt'
)

// A sweep that silently matched nothing must not report a clean bill.
export const POPULATION_FLOOR = 400
export const ALLOWLIST_FLOOR = 200

const METHOD_NAME_PATTERN = /\bname:\s*'([a-zA-Z][a-zA-Z0-9]*\.[a-zA-Z0-9_.]+)'/g

/** Every `.ts` file under dir, excluding tests. */
export function collectMethodSources(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectMethodSources(full))
    else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) out.push(full)
  }
  return out
}

export function parsePopulation(sources) {
  const methods = new Set()
  for (const file of sources) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(METHOD_NAME_PATTERN)) methods.add(m[1])
  }
  return methods
}

export function parseAllowlist(rpcSource) {
  const lines = rpcSource.split(/\r?\n/)
  const start = lines.findIndex((l) => l.includes('const MOBILE_RPC_METHOD_ALLOWLIST'))
  if (start === -1) throw new Error('MOBILE_RPC_METHOD_ALLOWLIST not found')
  const allowlist = new Set()
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\]\)/.test(lines[i])) return allowlist
    const m = lines[i].match(/^\s*'([^']+)'/)
    if (m) allowlist.add(m[1])
  }
  throw new Error('MOBILE_RPC_METHOD_ALLOWLIST block was never closed')
}

export function parseBaseline(text) {
  return new Set(
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
  )
}

/**
 * Pure verdict. Takes the three populations and returns every failure found, so a drill can drive
 * each red branch with synthetic subjects that cannot be fixed out from under the assertion.
 */
export function evaluateAperture({
  population,
  allowlist,
  baseline,
  populationFloor = POPULATION_FLOOR,
  allowlistFloor = ALLOWLIST_FLOOR
}) {
  const pop = new Set(population)
  const allow = new Set(allowlist)
  const base = new Set(baseline)

  const hostOnly = new Set([...pop].filter((m) => !allow.has(m)))
  const reachable = [...allow].filter((m) => pop.has(m)).sort()
  const allowedButAbsent = [...allow].filter((m) => !pop.has(m)).sort()
  const newlyHostOnly = [...hostOnly].filter((m) => !base.has(m)).sort()
  const staleBaseline = [...base].filter((m) => !hostOnly.has(m)).sort()

  const failures = []

  if (pop.size < populationFloor) {
    failures.push({
      kind: 'population-floor',
      message:
        `found ${pop.size} host RPC methods, expected at least ${populationFloor}. The enumerator ` +
        `probably stopped matching — fix it before trusting any verdict below.`
    })
  }
  if (allow.size < allowlistFloor) {
    failures.push({
      kind: 'allowlist-floor',
      message: `parsed ${allow.size} allowlist entries, expected at least ${allowlistFloor}.`
    })
  }
  if (allowedButAbsent.length > 0) {
    failures.push({
      kind: 'allowed-but-absent',
      message:
        `${allowedButAbsent.length} allowlisted method(s) do not exist in the host population — ` +
        `either the enumerator missed a declaration shape, or the allowlist names a method that ` +
        `was deleted or renamed:\n    ${allowedButAbsent.join('\n    ')}`
    })
  }
  if (newlyHostOnly.length > 0) {
    failures.push({
      kind: 'new-host-only',
      message:
        `${newlyHostOnly.length} host RPC method(s) are unreachable from mobile and not baselined.\n` +
        `    A new host method owes a decision: expose it by adding it to\n` +
        `    MOBILE_RPC_METHOD_ALLOWLIST, or record why it is desktop-only in\n` +
        `    config/variant-parity.jsonc and add it to the baseline deliberately.\n` +
        `    ${newlyHostOnly.join('\n    ')}`
    })
  }
  if (staleBaseline.length > 0) {
    const reachableNow = staleBaseline.filter((m) => allow.has(m))
    const goneNow = staleBaseline.filter((m) => !pop.has(m))
    failures.push({
      kind: 'stale-baseline',
      message:
        `${staleBaseline.length} baseline entr(ies) are no longer host-only and must be removed ` +
        `(${reachableNow.length} now reachable from mobile, ${goneNow.length} no longer exist):\n    ` +
        staleBaseline.join('\n    ')
    })
  }

  return {
    failures,
    populationSize: pop.size,
    allowlistSize: allow.size,
    reachable,
    hostOnly: [...hostOnly].sort(),
    newlyHostOnly,
    staleBaseline,
    allowedButAbsent
  }
}

export function baselineFileBody(hostOnly, populationSize, reachableCount, today) {
  return (
    [
      '# Host RPC methods that are unreachable from mobile, frozen at the first aperture audit.',
      '#',
      '# Why a baseline and not a clean-bill gate: these were already host-only when this gate',
      '# landed, and a gate that is red on arrival gets disabled within a week. Existing debt stays',
      '# visible here while a NEW host-only method fails the build, so the next one is a decision',
      '# somebody makes in a diff rather than an omission nobody sees.',
      '#',
      '# This list may only SHRINK, in both directions. An entry that becomes reachable from mobile,',
      '# or that no longer exists, fails as a stale exception — so the list cannot outlive its',
      '# subjects and cannot be padded with methods that are not really host-only.',
      '#',
      '# Being listed here is NOT a disposition. It records that a method is unreachable from',
      '# mobile, not that it should be. config/variant-parity.jsonc is where a capability gets an',
      '# argued disposition; config/mobile-capability-aperture-audit.md classifies this whole set.',
      '#',
      `# Frozen ${today}: ${hostOnly.length} host-only of ${populationSize} host RPC methods ` +
        `(${reachableCount} reachable from mobile).`,
      ''
    ]
      .concat(hostOnly)
      .join('\n') + '\n'
  )
}

function flagValue(name, fallback) {
  const i = process.argv.indexOf(name)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

function main() {
  const methodsDir = path.resolve(flagValue('--methods-dir', DEFAULT_METHODS_DIR))
  const rpcFile = path.resolve(flagValue('--rpc-file', DEFAULT_RPC_FILE))
  const baselinePath = path.resolve(flagValue('--baseline', DEFAULT_BASELINE))

  const population = parsePopulation(collectMethodSources(methodsDir))
  const allowlist = parseAllowlist(fs.readFileSync(rpcFile, 'utf8'))
  const baseline = fs.existsSync(baselinePath)
    ? parseBaseline(fs.readFileSync(baselinePath, 'utf8'))
    : new Set()

  const result = evaluateAperture({ population, allowlist, baseline })

  if (process.argv.includes('--write-baseline')) {
    // Refuse a degenerate baseline: an empty one refuses the whole surface while reporting that
    // the METHODS are unrecognised, which points the next reader at entirely the wrong thing.
    const floorFailed = result.failures.some(
      (f) => f.kind === 'population-floor' || f.kind === 'allowlist-floor'
    )
    if (floorFailed) {
      console.error('refusing to write a baseline from a sweep that failed its own floor check')
      process.exit(1)
    }
    if (result.hostOnly.length === 0) {
      console.error(
        'refusing to write an empty baseline — a sweep that matched nothing is not a clean estate'
      )
      process.exit(1)
    }
    fs.writeFileSync(
      baselinePath,
      baselineFileBody(
        result.hostOnly,
        result.populationSize,
        result.reachable.length,
        new Date().toISOString().slice(0, 10)
      ),
      'utf8'
    )
    console.log(`wrote ${result.hostOnly.length} entries to ${path.relative(REPO_ROOT, baselinePath)}`)
    return
  }

  const pct =
    result.populationSize > 0
      ? ((result.reachable.length / result.populationSize) * 100).toFixed(1)
      : '0.0'
  console.log(
    `mobile capability aperture: ${result.reachable.length}/${result.populationSize} host RPC ` +
      `methods reachable (${pct}%), ${result.hostOnly.length} host-only, ${baseline.size} baselined`
  )

  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2))

  if (result.failures.length > 0) {
    console.error('\nFAIL: mobile capability aperture\n')
    for (const f of result.failures) console.error(`  - [${f.kind}] ${f.message}\n`)
    process.exit(1)
  }

  console.log('PASS: no unclassified host-only RPC method')
}

/**
 * Whether this module is the entry point. Compares REAL paths: node resolves symlinks and Windows
 * junctions when it resolves a module, but `process.argv[1]` keeps the spelling the caller typed.
 * A plain string compare therefore fails whenever the repo is reached through a link — a git
 * worktree, a junction, a symlinked checkout — and the script then exits 0 having printed nothing,
 * which is indistinguishable from a pass.
 */
export function isEntryPoint(argvPath, moduleFilename) {
  if (!argvPath) return false
  const real = (p) => {
    try {
      return fs.realpathSync(path.resolve(p))
    } catch {
      return path.resolve(p)
    }
  }
  return real(argvPath) === real(moduleFilename)
}

if (isEntryPoint(process.argv[1], import.meta.filename)) {
  main()
}
