import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

import { parse, printParseErrorCode } from 'jsonc-parser'

const MANIFEST_PATH = path.join('config', 'durability-contracts.jsonc')
const BASELINE_PATH = path.join('config', 'durability-unclassified-baseline.txt')
// Kept separate from the atomic-publisher baseline: the two lists mean different
// things, and merging them would make "classified it" indistinguishable from
// "rewrote it to stage and rename" when an entry moves between them.
const DIRECT_BASELINE_PATH = path.join('config', 'durability-direct-writer-baseline.txt')
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
    /\.sync\s*\(\s*\)/.test(source) ||
    // shared/secure-file's durable variants fsync the staged handle before the rename, the same
    // barrier by a different name. Credential and identity writers need its 0600/ACL publish, so
    // routing them through durable-file-write instead would trade the barrier for the permissions.
    /\bwriteDurableSecure(?:Json)?File\s*\(/.test(source) ||
    /\bdurable:\s*true\b/.test(source)
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

/**
 * A contract describes STATE, and state can have more than one publisher. Naming only the obvious
 * one is how orca-data.json ended up with a durable writer in loading-store and a bare rename in
 * profile transfer while the contract read as satisfied. Accepts a string or an array so a contract
 * can enumerate every writer it knows about, and the gate then holds each of them to the tier.
 */
export function contractWriters(contract) {
  if (isNonEmptyString(contract?.writer)) {
    return [contract.writer]
  }
  return Array.isArray(contract?.writer) ? contract.writer.filter(isNonEmptyString) : []
}

/** Modules that publish a file atomically but carry no durability classification. */
export async function collectUnclassifiedPublishers(manifest, root) {
  const registered = new Set(
    (Array.isArray(manifest?.contracts) ? manifest.contracts : [])
      .filter(isRecord)
      .flatMap(contractWriters)
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

const WRITE_CALL = /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream)\s*\(/
/**
 * Destinations that outlive the process and belong to the user's install, as
 * opposed to a temp dir, a build output, a worktree checkout, or a path the
 * caller handed in (writing the user's own files is not app state).
 */
const USER_DATA_DESTINATION =
  /getPath\(\s*['"]userData['"]\s*\)|\.orca\b|getOrcaDir|userDataPath|getUserDataPath/

/**
 * The shape that made openai-api-key-store invisible: a plain write, straight
 * onto a path in the user's data directory, with no temp file to give it away.
 *
 * Why this exists next to looksLikeAtomicPublisher rather than replacing it:
 * keying discovery on the *safer* implementation shape meant the weakest
 * writers were the ones the gate could not see, which inverts the reliability
 * economics it exists to enforce. A staged publisher announced itself; a bare
 * writeFileSync said nothing.
 *
 * Why not every direct write: measured against src/main, 97 non-test modules
 * write directly and only 31 aim at a user-data destination. Flagging all 97
 * would bury the signal under PDF exports, downloaded binaries, generated shell
 * shims, and handlers that write files the user asked for — and a gate that
 * cries wolf gets suppressed rather than satisfied.
 */
export function looksLikeDirectStateWriter(source) {
  return (
    WRITE_CALL.test(source) &&
    USER_DATA_DESTINATION.test(source) &&
    !looksLikeAtomicPublisher(source)
  )
}

/** Modules that write state straight into the user's data directory with no contract. */
export async function collectUnclassifiedDirectWriters(manifest, root) {
  const registered = new Set(
    (Array.isArray(manifest?.contracts) ? manifest.contracts : [])
      .filter(isRecord)
      .flatMap(contractWriters)
  )
  const primitive = manifest?.policy?.durablePrimitive
  const unclassified = []
  for (const relativePath of await collectSourceFiles(root, SCAN_ROOT)) {
    if (registered.has(relativePath) || relativePath === primitive) {
      continue
    }
    const source = await readFileOrNull(root, relativePath)
    if (source !== null && looksLikeDirectStateWriter(source)) {
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
  for (const field of ['id', 'state', 'tier', 'lostIf']) {
    if (!isNonEmptyString(contract[field])) {
      failures.push(`${id}: ${field} must be a non-empty string`)
    }
  }
  const writers = contractWriters(contract)
  if (writers.length === 0) {
    failures.push(`${id}: writer must be a non-empty string or array of strings`)
  }
  if (!Array.isArray(contract.knownGaps) || !contract.knownGaps.every(isNonEmptyString)) {
    failures.push(`${id}: knownGaps must be an array of strings`)
  }
  if (!policy.tiers.has(contract.tier)) {
    failures.push(`${id}: tier is not one of policy.tiers`)
  }
  // Every listed writer is held to the tier: a contract is only as strong as its weakest publisher.
  for (const writer of writers) {
    const source = await readFileOrNull(root, writer)
    if (source === null) {
      failures.push(`${id}: writer does not exist: ${writer}`)
      continue
    }
    if (contract.tier === 'crash-durable' && !hasDurabilityBarrier(source)) {
      failures.push(
        `${id}: crash-durable state is written by ${writer}, which has no durability barrier — route it through ${policy.durablePrimitive} or fsync before the rename`
      )
    }
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

/**
 * Two lists, one ratchet mechanism. The second exists because keying discovery
 * on the atomic-publish shape left the least durable writers invisible: the
 * OpenAI speech key was a bare writeFileSync into ~/.orca and the gate passed
 * it every time, while a module that took the trouble to stage and rename got
 * asked for a contract.
 */
const RATCHETS = [
  {
    baselinePath: BASELINE_PATH,
    collect: collectUnclassifiedPublishers,
    noun: 'durability publisher',
    shape: 'stage a temp file and rename it into place',
    headerShape: 'publish state atomically (temp file + rename)'
  },
  {
    baselinePath: DIRECT_BASELINE_PATH,
    collect: collectUnclassifiedDirectWriters,
    noun: 'direct state writer',
    shape: "write straight onto a path in the user's data directory",
    headerShape: "write state directly into the user's data directory (no temp file, no rename)"
  }
]

function printAddedFailure(added, ratchet) {
  for (const entry of added) {
    console.error(`::error::New unclassified ${ratchet.noun}: ${entry}`)
  }
  console.error('')
  console.error('  ❌  durability ratchet failed — a NEW module publishes state with no contract.')
  console.error('')
  console.error(`  ${added.length} module(s) ${ratchet.shape}, but no`)
  console.error(`  entry in ${toPosix(MANIFEST_PATH)} says what is lost if that state disappears:`)
  console.error('')
  for (const entry of added) {
    console.error(`    • ${entry}`)
  }
  console.error('')
  console.error(`  Existing ${ratchet.noun}s are grandfathered; NEW ones are not, so`)
  console.error('  "there were already some" is not an argument for adding another.')
  console.error('')
  console.error('  ✅  Fix it: add a contract naming the state, what breaks if it is lost, and its')
  console.error('      tier. crash-durable writers must route through the durable primitive and')
  console.error('      carry a syscall-order proof; regenerable state owes nothing.')
  console.error('')
}

function printStaleFailure(stale, ratchet) {
  for (const entry of stale) {
    console.error(`::error::Stale durability baseline entry (prune it): ${entry}`)
  }
  console.error('')
  console.error('  ⚠️  durability baseline is out of date — nice work classifying a writer!')
  console.error('')
  console.error(`  ${stale.length} entr(y/ies) in ${toPosix(ratchet.baselinePath)} are no longer`)
  console.error(`  ${ratchet.noun}s. The baseline may only shrink, so remove them to keep`)
  console.error('  re-adding blocked:')
  console.error('')
  for (const entry of stale) {
    console.error(`    • ${entry}`)
  }
  console.error('')
  console.error('  ✅  Fix it (one command):  pnpm check:durability-contracts --prune')
  console.error('')
}

function baselineHeader(ratchet) {
  return [
    `# Modules under src/main that ${ratchet.headerShape} but carry no`,
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

  const summary = []
  for (const ratchet of RATCHETS) {
    const baselineRaw = await readFileOrNull(root, ratchet.baselinePath)
    if (baselineRaw === null) {
      console.error(
        `::error::Missing ${toPosix(ratchet.baselinePath)}. Generate it with: node config/scripts/check-durability-contracts.mjs --init`
      )
      return 1
    }
    const current = await ratchet.collect(manifest, root)
    const { added, stale } = diffBaseline(current, parseBaseline(baselineRaw))
    if (added.length > 0) {
      printAddedFailure(added, ratchet)
      if (stale.length > 0) {
        printStaleFailure(stale, ratchet)
      }
      return 1
    }
    if (stale.length > 0) {
      printStaleFailure(stale, ratchet)
      return 1
    }
    summary.push(`${current.length} grandfathered ${ratchet.noun}(s)`)
  }
  console.log(
    `Durability contract check passed for ${manifest.contracts.length} contract(s); ${summary.join('; ')}; no new ones.`
  )
  return 0
}

async function writeBaseline(root, ratchet, entries) {
  await fs.writeFile(
    path.join(root, ratchet.baselinePath),
    `${baselineHeader(ratchet)}${entries.join('\n')}\n`
  )
}

async function readManifestForCli(root) {
  const raw = await fs.readFile(path.join(root, MANIFEST_PATH), 'utf8')
  return parse(raw, [], { allowTrailingComma: true })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.cwd()
  const arg = process.argv[2]
  if (arg === '--init') {
    const manifest = await readManifestForCli(root)
    for (const ratchet of RATCHETS) {
      const entries = await ratchet.collect(manifest, root)
      await writeBaseline(root, ratchet, entries)
      console.log(`Wrote ${toPosix(ratchet.baselinePath)} with ${entries.length} entries.`)
    }
    process.exit(0)
  }
  if (arg === '--prune') {
    // Shrink only: drops entries that are now classified, never adopts new debt.
    const manifest = await readManifestForCli(root)
    let remaining = 0
    for (const ratchet of RATCHETS) {
      const current = new Set(await ratchet.collect(manifest, root))
      const baseline = parseBaseline(
        await fs.readFile(path.join(root, ratchet.baselinePath), 'utf8')
      )
      const kept = [...baseline].filter((entry) => current.has(entry)).sort()
      const newlyAdded = [...current].filter((entry) => !baseline.has(entry))
      await writeBaseline(root, ratchet, kept)
      console.log(
        `Pruned ${toPosix(ratchet.baselinePath)} to ${kept.length} entries (removed ${baseline.size - kept.length}).`
      )
      if (newlyAdded.length > 0) {
        console.error(
          `::error::--prune does not add entries; ${newlyAdded.length} ${ratchet.noun}(s) remain — classify those.`
        )
        remaining += newlyAdded.length
      }
    }
    process.exit(remaining > 0 ? 1 : 0)
  }
  process.exit(await main(root))
}
