import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

import { parse, printParseErrorCode } from 'jsonc-parser'

const MANIFEST_PATH = path.join('config', 'durability-contracts.jsonc')
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
 * Why an import check rather than a call-site check: the ordering guarantee lives inside the
 * primitive, so importing it is what makes the guarantee reachable. A writer that hand-rolls its own
 * fsync sequence is exactly what this gate is meant to surface for review, not to silently accept.
 */
function importsDurablePrimitive(source) {
  return /from\s+['"][^'"]*durable-file-write['"]/.test(source)
}

/** The publish shape: stage under a temp name, then rename it into place. */
function looksLikeAtomicPublisher(source) {
  return /\.tmp\b/.test(source) && /\brename(?:Sync)?\s*\(/.test(source)
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
      Array.isArray(manifest.policy.proofRequiredForTiers) ? manifest.policy.proofRequiredForTiers : []
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
  if (contract.tier === 'crash-durable' && !importsDurablePrimitive(source)) {
    failures.push(
      `${id}: crash-durable state is written by ${contract.writer}, which does not import ${policy.durablePrimitive}`
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

/**
 * The omission closer. Every gap fixed here was invisible because nothing ever asked whether a new
 * writer persisted recovery-critical state. Report mode lists unclassified publishers without
 * failing; the backlog is real and classifying it wrongly is worse than classifying it slowly.
 */
async function reportUnclassifiedPublishers(manifest, root) {
  const registered = new Set(
    (Array.isArray(manifest.contracts) ? manifest.contracts : [])
      .filter((contract) => isRecord(contract) && isNonEmptyString(contract.writer))
      .map((contract) => contract.writer)
  )
  const primitive = manifest.policy?.durablePrimitive
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
  return unclassified
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
  const unclassified = isRecord(manifest) ? await reportUnclassifiedPublishers(manifest, root) : []
  console.log(`Durability contract check passed for ${manifest.contracts.length} contract(s).`)
  if (unclassified.length > 0) {
    // Never silent: a truncated list reads as "everything is covered" when it is not.
    console.log(
      `${unclassified.length} unclassified atomic publisher(s) under ${toPosix(SCAN_ROOT)} (report-only):`
    )
    for (const relativePath of unclassified) {
      console.log(`- ${relativePath}`)
    }
  }
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main())
}
