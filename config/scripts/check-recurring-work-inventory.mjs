// Recurring-work inventory gate (Resource Elasticity R4). Every recurring producer in src/ must be
// classified in config/recurring-work-inventory.jsonc, and the set of responsibilities marked
// `debt` may only shrink (config/recurring-work-debt-baseline.txt).
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { parse, printParseErrorCode } from 'jsonc-parser'
import { scanRecurringWork } from './recurring-work-scan.mjs'

export const INVENTORY_PATH = 'config/recurring-work-inventory.jsonc'
export const BASELINE_PATH = 'config/recurring-work-debt-baseline.txt'

// Why: a sweep that silently stopped matching must not read as a clean estate.
export const SITE_FLOOR = {
  total: 200,
  interval: 40,
  'self-rescheduling-timeout': 60,
  'self-rescheduling-frame': 10,
  watcher: 5,
  worker: 8,
  helper: 20
}

export const SCALING = {
  global: false,
  'per-process': false,
  'per-window': false,
  'per-host': false,
  'per-remote-host': true,
  'per-connection': true,
  'per-project': true,
  'per-worktree': true,
  'per-sidebar-row': true,
  'per-open-pane': true,
  'per-visible-pane': true,
  'per-browser-pane': true,
  'per-live-pty': true,
  'per-live-agent': true,
  'per-logical-session': true,
  'per-subscriber': true,
  'per-request': true,
  unknown: true
}
const LIFETIME = new Set(['persistent', 'while-active', 'bounded'])
const HIDDEN = new Set(['paused', 'runs', 'n/a', 'unknown'])
const DORMANT = new Set(['none', 'runs', 'n/a', 'unknown'])
const DISPOSITION = new Set(['justified', 'debt'])
const MIN_BOUND_LENGTH = 12

export function isMultiplicative(scaling) {
  return SCALING[scaling] === true
}

function kindGroup(kind) {
  return kind.startsWith('helper:') ? 'helper' : kind
}

function validateEntry(key, entry) {
  const problems = []
  if (!entry || typeof entry !== 'object') {
    return [`${key}: entry must be an object`]
  }
  if (
    typeof entry.responsibility !== 'string' ||
    !/^[a-z0-9][a-z0-9-]*$/.test(entry.responsibility)
  ) {
    problems.push(`${key}: responsibility must be a kebab-case id`)
  }
  if (typeof entry.cadence !== 'string' || entry.cadence.trim() === '') {
    problems.push(`${key}: cadence is required (write "unknown" when it is)`)
  }
  if (!LIFETIME.has(entry.lifetime)) {
    problems.push(`${key}: lifetime must be one of ${[...LIFETIME].join(', ')}`)
  }
  if (!(entry.scaling in SCALING)) {
    problems.push(`${key}: scaling must be one of ${Object.keys(SCALING).join(', ')}`)
  }
  if (!HIDDEN.has(entry.hidden)) {
    problems.push(`${key}: hidden must be one of ${[...HIDDEN].join(', ')}`)
  }
  if (!DORMANT.has(entry.dormant)) {
    problems.push(`${key}: dormant must be one of ${[...DORMANT].join(', ')}`)
  }
  if (typeof entry.spawns !== 'string' || entry.spawns.trim() === '') {
    problems.push(`${key}: spawns is required ("none", a binary, or "unknown")`)
  }
  if (!DISPOSITION.has(entry.disposition)) {
    problems.push(`${key}: disposition must be justified or debt`)
  }
  // Why: a multiplicative producer that never stops on its own is accepted only with a stated bound.
  if (
    entry.disposition === 'justified' &&
    entry.lifetime !== 'bounded' &&
    isMultiplicative(entry.scaling) &&
    (typeof entry.bound !== 'string' || entry.bound.trim().length < MIN_BOUND_LENGTH)
  ) {
    problems.push(
      `${key}: a justified ${entry.scaling} producer needs a "bound" saying what caps it`
    )
  }
  return problems
}

export function evaluateRecurringWork({ sites, inventory, baseline, floor = SITE_FLOOR }) {
  const errors = []
  const entries = inventory.sites ?? {}
  const helpers = inventory.helpers ?? []
  const discovered = new Map(sites.map((site) => [site.key, site]))

  const counts = { total: sites.length }
  for (const site of sites) {
    const group = kindGroup(site.kind)
    counts[group] = (counts[group] ?? 0) + 1
  }
  for (const [kind, min] of Object.entries(floor)) {
    if ((counts[kind] ?? 0) < min) {
      errors.push(
        `floor: found ${counts[kind] ?? 0} ${kind} site(s), expected at least ${min}; the sweep may have stopped seeing code`
      )
    }
  }
  for (const helper of helpers) {
    if (!sites.some((site) => site.kind === `helper:${helper}`)) {
      errors.push(`helper ${helper} has no call sites; remove it from "helpers"`)
    }
  }
  for (const [key, site] of discovered) {
    const entry = entries[key]
    if (!entry) {
      errors.push(`unclassified: ${key} (${site.file}:${site.line})`)
      continue
    }
    errors.push(...validateEntry(key, entry))
    if (site.spawnsDetected && entry.spawns === 'none') {
      errors.push(`${key}: its callback reaches a process spawn but spawns is "none"`)
    }
  }
  for (const key of Object.keys(entries)) {
    if (!discovered.has(key)) {
      errors.push(
        `stale: ${key} no longer exists in source; delete the entry (or re-key it if the code moved)`
      )
    }
  }

  const debt = new Set(
    Object.entries(entries)
      .filter(([key, entry]) => discovered.has(key) && entry?.disposition === 'debt')
      .map(([, entry]) => entry.responsibility)
  )
  const baselineSet = new Set(baseline)
  for (const id of debt) {
    if (!baselineSet.has(id)) {
      errors.push(
        `new debt: ${id} is not in ${BASELINE_PATH}; the debt list only shrinks — share or bound the producer instead`
      )
    }
  }
  const pruned = []
  for (const id of baselineSet) {
    if (!debt.has(id)) {
      pruned.push(id)
      errors.push(
        `resolved debt: ${id} is no longer debt; remove it from ${BASELINE_PATH} (--prune)`
      )
    }
  }
  return { errors, debt: [...debt].sort(), pruned, counts }
}

export function parseBaseline(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
}

export async function readInventory(root) {
  const text = await fs.readFile(path.join(root, INVENTORY_PATH), 'utf8')
  const parseErrors = []
  const inventory = parse(text, parseErrors, { allowTrailingComma: true })
  if (parseErrors.length > 0 || !inventory || typeof inventory !== 'object') {
    const detail = parseErrors.map((e) => `${printParseErrorCode(e.error)}@${e.offset}`).join(', ')
    throw new Error(`${INVENTORY_PATH} is not valid JSONC: ${detail || 'not an object'}`)
  }
  return inventory
}

export async function main(root, args = [], options = {}) {
  let inventory
  let baselineText
  try {
    inventory = await readInventory(root)
    baselineText = await fs.readFile(path.join(root, BASELINE_PATH), 'utf8')
  } catch (error) {
    // Why: a gate that could not read its inputs has judged nothing; say so, distinct from a finding.
    console.error(`::error::recurring-work gate could not run: ${error.message}`)
    return 2
  }
  const sites = await scanRecurringWork(root, inventory.helpers ?? [])
  const result = evaluateRecurringWork({
    sites,
    inventory,
    baseline: parseBaseline(baselineText),
    ...(options.floor ? { floor: options.floor } : {})
  })

  if (args.includes('--prune') && result.pruned.length > 0) {
    const kept = baselineText
      .split(/\r?\n/)
      .filter((line) => !result.pruned.includes(line.trim()))
      .join('\n')
    await fs.writeFile(path.join(root, BASELINE_PATH), kept)
    console.log(`Pruned ${result.pruned.length} resolved debt id(s): ${result.pruned.join(', ')}`)
    return main(root, [], options)
  }
  if (args.includes('--skeleton')) {
    const skeleton = {}
    for (const site of sites) {
      if (!inventory.sites?.[site.key]) {
        skeleton[site.key] = {
          responsibility: '',
          cadence: '',
          lifetime: '',
          scaling: '',
          hidden: '',
          dormant: '',
          spawns: site.spawnsDetected ? 'unknown' : 'none',
          disposition: '',
          note: `${site.file}:${site.line}`
        }
      }
    }
    console.log(JSON.stringify(skeleton, null, 2))
    return 0
  }

  const summary = Object.entries(result.counts)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')
  if (result.errors.length > 0) {
    console.error(`Recurring-work inventory: ${result.errors.length} problem(s) [${summary}]`)
    for (const error of result.errors) {
      console.error(`  ✗ ${error}`)
    }
    console.error(
      `  Classify new recurring work in ${INVENTORY_PATH}; see docs/reference/resource-elasticity-fabric.md (R4).`
    )
    return 1
  }
  console.log(`Recurring-work inventory OK [${summary}] debt=${result.debt.length}`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.cwd(), process.argv.slice(2)))
}
