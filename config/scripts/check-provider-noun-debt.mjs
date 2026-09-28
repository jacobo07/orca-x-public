// The provider brand type is `ProviderType`. A population of local identifiers still spells it
// `...AgentType` (`baselineAgentType`, `resolveExplicitTerminalTitleAgentType`). Renaming them
// would touch surfaces other writers hold and one name mobile imports across a relative path, so
// they are frozen here instead: the list may only shrink, and new debt fails the build.
//
// Deliberately NOT matched: the lowercase `agentType` wire field, which is a compatibility
// contract with producers outside Orca and is pinned by agent-status-wire-field-name.test.ts.

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '../..')
const BASELINE = join(ROOT, 'config/provider-noun-debt-baseline.txt')
const ROOTS = ['src', 'mobile/src']
const EXTS = /\.(ts|tsx|mts|cts|mjs)$/
const SKIP = /node_modules|[\\/]\.git|[\\/]dist|[\\/]out[\\/]|[\\/]build[\\/]/

// Why a floor: an empty result is what a sweep that stopped matching also returns, and an empty
// expectation is satisfied by an empty reality. This number is a smoke alarm, not a target.
const POPULATION_FLOOR = 300

const COMPOUND = /\b\w+AgentType\b/g

function walk(dir, acc = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return acc
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    if (SKIP.test(full)) {
      continue
    }
    let stats
    try {
      stats = statSync(full)
    } catch {
      continue
    }
    if (stats.isDirectory()) {
      walk(full, acc)
    } else if (EXTS.test(full)) {
      acc.push(full)
    }
  }
  return acc
}

/** Keyed by file + identifier, never by line, so moving code does not churn the baseline and
 *  renaming a file forces the entry to be re-justified rather than silently carried. */
function sweep() {
  const found = new Map()
  let total = 0
  for (const root of ROOTS) {
    for (const file of walk(join(ROOT, root))) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.match(COMPOUND) ?? []) {
        total += 1
        const key = `${relative(ROOT, file).replaceAll('\\', '/')}\t${match}`
        found.set(key, (found.get(key) ?? 0) + 1)
      }
    }
  }
  return { keys: new Set(found.keys()), total }
}

function readBaseline() {
  try {
    return new Set(
      readFileSync(BASELINE, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'))
        .map((line) => line.replace(/ {2,}/, '\t'))
    )
  } catch {
    return null
  }
}

const { keys, total } = sweep()

if (process.argv.includes('--update')) {
  const header = [
    '# Identifiers still spelling the provider brand as "AgentType".',
    '# Shrink-only: prune an entry once its identifier is renamed. Adding one fails the build.',
    '# Regenerate with: node config/scripts/check-provider-noun-debt.mjs --update',
    ''
  ].join('\n')
  writeFileSync(BASELINE, `${header}${[...keys].sort().join('\n')}\n`, 'utf8')
  console.log(`provider-noun debt: wrote ${keys.size} entries (${total} occurrences)`)
  process.exit(0)
}

const baseline = readBaseline()
if (baseline === null) {
  console.error(`provider-noun debt: baseline missing at ${relative(ROOT, BASELINE)}`)
  process.exit(1)
}

const failures = []

// Compares occurrences to an occurrence floor. An earlier version guarded this with
// `baseline.size >= POPULATION_FLOOR`, comparing entries (106) to an occurrence floor (300),
// so the branch could never be taken.
if (total < POPULATION_FLOOR) {
  failures.push(
    `found ${total} compound occurrences, expected at least ${POPULATION_FLOOR}; either the debt was genuinely paid down (lower the floor deliberately) or the sweep stopped seeing code`
  )
}

const listed = (entries) =>
  entries
    .sort()
    .slice(0, 20)
    .map((key) => `    ${key.replace('\t', '  ')}`)
    .join('\n')

const added = [...keys].filter((key) => !baseline.has(key))
if (added.length > 0) {
  failures.push(
    `${added.length} new provider-noun identifier(s) — name new code after ProviderType:\n${listed(added)}`
  )
}

// Stale entries: without this the list outlives its debts and stops being a ratchet.
const stale = [...baseline].filter((key) => !keys.has(key))
if (stale.length > 0) {
  failures.push(
    `${stale.length} baseline entr(ies) no longer exist — prune with --update:\n${listed(stale)}`
  )
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`provider-noun debt: ${failure}`)
  }
  process.exit(1)
}

console.log(
  `provider-noun debt OK [entries=${keys.size} occurrences=${total} floor=${POPULATION_FLOOR}] added=0 stale=0`
)
