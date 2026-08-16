import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

import { parse, printParseErrorCode } from 'jsonc-parser'

const MANIFEST_PATH = path.join('config', 'durability-contracts.jsonc')
const BASELINE_PATH = path.join('config', 'durability-unclassified-baseline.txt')
const SCAN_ROOT = path.join('src', 'main')

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function hasNonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString)
}

function toPosix(value) {
  return value.split(path.sep).join('/')
}

async function readFileOrNull(root, relativePath) {
  try {
    return await fs.readFile(path.join(root, relativePath), 'utf8')
  } catch {
    return null
  }
}

/**
 * Why "has a barrier" rather than "imports our helper": integration-credential-file.ts fsyncs the
 * handle before renaming and is genuinely durable, it just predates the shared primitive. Failing it
 * would be a false positive, and a gate that cries wolf gets suppressed. Ordering is what actually
 * matters and static text cannot show it — that is what the required syscall-order proof is for.
 */
export function hasDurabilityBarrier(source) {
  return (
    /from\s+['"][^'"]*durable-file-write['"]/.test(source) ||
    /\bfsync(?:Sync)?\s*\(/.test(source) ||
    /\.sync\s*\(\s*\)/.test(source)
  )
}

/** The publish shape: stage under a temp name, then rename it into place. */
export function looksLikeAtomicPublisher(source) {
  return /\.tmp\b/.test(source) && /\brename(?:Sync)?\s*\(/.test(source)
}

// Deliberately local rather than imported from check-max-lines-ratchet.mjs: these are generic set
// and text helpers, and coupling two unrelated CI gates so one can borrow a three-line diff would
// add conflict surface to a fast-moving upstream file for no reliability gain.
export function parseBaseline(text) {
  return new Set(
    text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
  )
}

export function diffBaseline(current, baseline) {
  const cur = new Set(current)
  const base = baseline instanceof Set ? baseline : new Set(baseline)
  const added = [...cur].filter((entry) => !base.has(entry)).sort()
  const stale = [...base].filter((entry) => !cur.has(entry)).sort()
  return { added, stale }
}

async function collectSourceFiles(root, relativeDir, found = []) {
  let entries
  try {
    entries = await fs.readdir(path.join(root, relativeDir), { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    const relativePath = path.join(relativeDir, entry.name)
    if (entry.isDirectory()) {
      await collectSourceFiles(root, relativePath, found)
      continue
    }
    if (!entry.name.endsWith('.ts') || entry.name.includes('.test.')) {
      continue
    }
    found.push(toPosix(relativePath))
  }
  return found
}

/** Modules that publish a file atomically but carry no durability classification. */
export async function collectUnclassifiedPublishers(manifest, root) {
  const registered = new Set(
    (Array.isArray(manifest?.contracts) ? manifest.contracts : [])
      .filter((contract) => isRecord(contract) && isNonEmptyString(contract.writer))
      .map((contract) => contract.writer)
  )
  const primitive = manifest?.policy?.durablePrimitive
  const unclassified = []
  for (const relativePath of await collectSourceFiles(root, SCAN_ROOT)) {
    if (registered.has(relativePath) || relativePath === primitive) {
      continue
    }
    const source = await readFileOrNull(root, relativePath)
    if (source !== null && looksLikeAtomicPublisher(source)) {
      unclassified.push(relativePath)
    }
  }
  return unclassified.sort()
}

function validatePolicy(manifest, failures) {
  if (!isRecord(manifest.policy)) {
    failures.push('policy must be an object')
    return { tiers: new Set(), proofRequired: new Set(), durablePrimitive: null }
  }
  if (!hasNonEmptyStringArray(manifest.policy.tiers)) {
    failures.push('policy.tiers must be a non-empty string array')
  }
  if (!Array.isArray(manifest.policy.proofRequiredForTiers)) {
    failures.push('policy.proofRequiredForTiers must be an array')
  }
  if (!isNonEmptyString(manifest.policy.durablePrimitive)) {
    failures.push('policy.durablePrimitive must be a non-empty string')
  }
  return {
    tiers: new Set(Array.isArray(manifest.policy.tiers) ? manifest.policy.tiers : []),
    proofRequired: new Set(
      Array.isArray(manifest.policy.proofRequiredForTiers)
        ? manifest.policy.proofRequiredForTiers
        : []
    ),
    durablePrimitive: manifest.policy.durablePrimitive ?? null
  }
}

async function validateContract(contract, policy, root, failures) {
  if (!isRecord(contract)) {
    failures.push('contract entry must be an object')
    return
  }
  const id = contract.id ?? '<unknown>'
  for (const field of ['id', 'state', 'writer', 'tier', 'lostIf']) {
    if (!isNonEmptyString(contract[field])) {
      failures.push(`${id}: ${field} must be a non-empty string`)
    }
  }
  if (!Array.isArray(contract.knownGaps) || !contract.knownGaps.every(isNonEmptyString)) {
    failures.push(`${id}: knownGaps must be an array of strings`)
  }
  if (!policy.tiers.has(contract.tier)) {
    failures.push(`${id}: tier is not one of policy.tiers`)
  }
  if (!isNonEmptyString(contract.writer)) {
    return
  }
  const source = await readFileOrNull(root, contract.writer)
  if (source === null) {
    failures.push(`${id}: writer does not exist: ${contract.writer}`)
    return
  }
  if (contract.tier === 'crash-durable' && !hasDurabilityBarrier(source)) {
    failures.push(
      `${id}: crash-durable state is written by ${contract.writer}, which has no durability barrier — route it through ${policy.durablePrimitive} or fsync before the rename`
    )
  }
  if (!policy.proofRequired.has(contract.tier)) {
    return
  }
  if (!hasNonEmptyStringArray(contract.provenBy)) {
    failures.push(`${id}: tier ${contract.tier} requires a non-empty provenBy`)
    return
  }
  for (const proof of contract.provenBy) {
    if ((await readFileOrNull(root, proof)) === null) {
      failures.push(`${id}: proof does not exist: ${proof}`)
    }
  }
}

function printAddedFailure(added) {
  for (const entry of added) {
    console.error(`::error::New unclassified durability publisher: ${entry}`)
  }
  console.error('')
  console.error('  ❌  durability ratchet failed — a NEW module publishes state with no contract.')
  console.error('')
  console.error(`  ${added.length} module(s) stage a temp file and rename it into place, but no`)
  console.error(`  entry in ${toPosix(MANIFEST_PATH)} says what is lost if that state disappears:`)
  console.error('')
  for (const entry of added) {
    console.error(`    • ${entry}`)
  }
  console.error('')
  console.error('  Existing unclassified publishers are grandfathered; NEW ones are not, so')
  console.error('  "there were already some" is not an argument for adding another.')
  console.error('')
  console.error('  ✅  Fix it: add a contract naming the state, what breaks if it is lost, and its')
  console.error('      tier. crash-durable writers must route through the durable primitive and')
  console.error('      carry a syscall-order proof; regenerable state owes nothing.')
  console.error('')
}

function printStaleFailure(stale) {
  for (const entry of stale) {
    console.error(`::error::Stale durability baseline entry (prune it): ${entry}`)
  }
  console.error('')
  console.error('  ⚠️  durability baseline is out of date — nice work classifying a publisher!')
  console.error('')
  console.error(`  ${stale.length} baseline entr(y/ies) are no longer unclassified publishers.`)
  console.error('  The baseline may only shrink, so these must be removed to keep re-adding blocked:')
  console.error('')
  for (const entry of stale) {
    console.error(`    • ${entry}`)
  }
  console.error('')
  console.error('  ✅  Fix it (one command):  pnpm check:durability-contracts --prune')
  console.error('')
}

function baselineHeader() {
  return [
    '# Modules under src/main that publish state atomically (temp file + rename) but carry no',
    '# durability contract in config/durability-contracts.jsonc.',
    '#',
    '# This is a RATCHET: the list may only SHRINK. Do NOT add entries to get CI green — classify',
    '# the module instead. Existing debt stays visible here; new debt is blocked at the gate.',
    '# Prune after classifying: pnpm check:durability-contracts --prune',
    ''
  ].join('\n')
}

export async function main(root = process.cwd()) {
  const manifestPath = path.join(root, MANIFEST_PATH)
  let raw
  try {
    raw = await fs.readFile(manifestPath, 'utf8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`${MANIFEST_PATH}: unable to read manifest (${message})`)
    return 1
  }
  const parseErrors = []
  const manifest = parse(raw, parseErrors, { allowTrailingComma: true })
  if (parseErrors.length > 0) {
    for (const error of parseErrors) {
      console.error(
        `${MANIFEST_PATH}: JSONC parse error ${printParseErrorCode(error.error)} at offset ${error.offset}`
      )
    }
    return 1
  }
  const failures = []
  if (!isRecord(manifest)) {
    failures.push('manifest must be an object')
  } else {
    if (manifest.schemaVersion !== 1) {
      failures.push('schemaVersion must be 1')
    }
    const policy = validatePolicy(manifest, failures)
    if (!Array.isArray(manifest.contracts) || manifest.contracts.length === 0) {
      failures.push('contracts must be a non-empty array')
    } else {
      const seenIds = new Set()
      for (const contract of manifest.contracts) {
        if (isRecord(contract) && isNonEmptyString(contract.id)) {
          if (seenIds.has(contract.id)) {
            failures.push(`${contract.id}: duplicate contract id`)
          }
          seenIds.add(contract.id)
        }
        await validateContract(contract, policy, root, failures)
      }
    }
  }
  if (failures.length > 0) {
    console.error(`Durability contract check failed with ${failures.length} issue(s):`)
    for (const failure of failures) {
      console.error(`- ${failure}`)
    }
    return 1
  }

  const baselineRaw = await readFileOrNull(root, BASELINE_PATH)
  if (baselineRaw === null) {
    console.error(
      `::error::Missing ${toPosix(BASELINE_PATH)}. Generate it with: node config/scripts/check-durability-contracts.mjs --init`
    )
    return 1
  }
  const current = await collectUnclassifiedPublishers(manifest, root)
  const { added, stale } = diffBaseline(current, parseBaseline(baselineRaw))
  if (added.length > 0) {
    printAddedFailure(added)
    if (stale.length > 0) {
      printStaleFailure(stale)
    }
    return 1
  }
  if (stale.length > 0) {
    printStaleFailure(stale)
    return 1
  }
  console.log(
    `Durability contract check passed for ${manifest.contracts.length} contract(s); ${current.length} grandfathered unclassified publisher(s), no new ones.`
  )
  return 0
}

async function writeBaseline(root, entries) {
  await fs.writeFile(path.join(root, BASELINE_PATH), `${baselineHeader()}${entries.join('\n')}\n`)
}

async function readManifestForCli(root) {
  const raw = await fs.readFile(path.join(root, MANIFEST_PATH), 'utf8')
  return parse(raw, [], { allowTrailingComma: true })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.cwd()
  const arg = process.argv[2]
  if (arg === '--init') {
    const entries = await collectUnclassifiedPublishers(await readManifestForCli(root), root)
    await writeBaseline(root, entries)
    console.log(`Wrote ${toPosix(BASELINE_PATH)} with ${entries.length} entries.`)
    process.exit(0)
  }
  if (arg === '--prune') {
    // Shrink only: drops entries that are now classified, never adopts new debt.
    const current = new Set(await collectUnclassifiedPublishers(await readManifestForCli(root), root))
    const baseline = parseBaseline(await fs.readFile(path.join(root, BASELINE_PATH), 'utf8'))
    const kept = [...baseline].filter((entry) => current.has(entry)).sort()
    const newlyAdded = [...current].filter((entry) => !baseline.has(entry))
    await writeBaseline(root, kept)
    console.log(`Pruned baseline to ${kept.length} entries (removed ${baseline.size - kept.length}).`)
    if (newlyAdded.length > 0) {
      console.error(
        `::error::--prune does not add entries; ${newlyAdded.length} unclassified publisher(s) remain — classify those.`
      )
      process.exit(1)
    }
    process.exit(0)
  }
  process.exit(await main(root))
}
