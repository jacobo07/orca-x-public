import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

import { parse, printParseErrorCode } from 'jsonc-parser'

const MANIFEST_PATH = path.join('config', 'variant-parity.jsonc')
const BASELINE_PATH = path.join('config', 'variant-parity-unknown-baseline.txt')

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function hasNonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString)
}

/**
 * Four verdicts, not two.
 *
 * A checker that dies on a malformed manifest still exits non-zero, still blocks, and still reads as
 * "your capability is unclassified" -- sending someone to fix a subject that may be fine. Worse, a
 * throw partway through the loop means every capability after it went unjudged while the run still
 * presents as a complete verdict. So a verifier failure outranks any subject failure found in the
 * same run, and each capability is evaluated in isolation.
 */
export const VERDICT = {
  ok: 'ok',
  subjectInvalid: 'subject-invalid',
  verifierFailed: 'verifier-failed',
  unreadableInput: 'unreadable-input'
}

function evaluateCapability(capability, index, policy) {
  const problems = []
  const where = isRecord(capability) && isNonEmptyString(capability.id) ? capability.id : `#${index}`

  if (!isRecord(capability)) {
    return [{ id: where, message: 'capability entry is not an object' }]
  }
  if (!isNonEmptyString(capability.id)) {
    problems.push({ id: where, message: 'missing id' })
  }
  if (!isNonEmptyString(capability.title)) {
    problems.push({ id: where, message: 'missing title' })
  }

  const disposition = capability.disposition
  if (!isNonEmptyString(disposition) || !policy.dispositions.includes(disposition)) {
    problems.push({
      id: where,
      message: `disposition ${JSON.stringify(disposition ?? null)} is not one of ${policy.dispositions.join(', ')}`
    })
    return problems
  }

  // A claim of parity that cites nothing is the thing this gate exists to refuse.
  if (policy.evidenceRequiredFor.includes(disposition) && !hasNonEmptyStringArray(capability.evidence)) {
    problems.push({
      id: where,
      message: `disposition "${disposition}" claims parity and must cite evidence`
    })
  }
  if (policy.reasonRequiredFor.includes(disposition) && !isNonEmptyString(capability.reason)) {
    problems.push({
      id: where,
      message: `disposition "${disposition}" excuses parity and must give a reason`
    })
  }
  // An equivalent must say what it preserves, or "equivalent" is just a word.
  if (policy.invariantRequiredFor.includes(disposition) && !isNonEmptyString(capability.invariant)) {
    problems.push({
      id: where,
      message: 'disposition "equivalent" must name the invariant it preserves'
    })
  }
  if (disposition === 'blocked' && !isNonEmptyString(capability.owner)) {
    problems.push({ id: where, message: 'disposition "blocked" must name an owner' })
  }
  return problems
}

/**
 * Evidence is checked for EXISTENCE, not content. A path that no longer exists is a stale exception
 * -- the case where a capability's proof was deleted and the registry kept claiming it.
 */
function evaluateEvidencePaths(capabilities, knownPath) {
  const problems = []
  for (const capability of capabilities) {
    if (!isRecord(capability) || !Array.isArray(capability.evidence)) {
      continue
    }
    for (const reference of capability.evidence) {
      if (isNonEmptyString(reference) && !knownPath(reference)) {
        problems.push({
          id: isNonEmptyString(capability.id) ? capability.id : '#?',
          message: `evidence path does not exist: ${reference}`
        })
      }
    }
  }
  return problems
}

export function evaluateManifest({ manifest, baseline, knownPath }) {
  if (!isRecord(manifest) || !isRecord(manifest.policy) || !Array.isArray(manifest.capabilities)) {
    return { verdict: VERDICT.unreadableInput, problems: [{ id: '-', message: 'manifest is missing policy or capabilities' }] }
  }
  const policy = manifest.policy
  for (const field of ['dispositions', 'evidenceRequiredFor', 'reasonRequiredFor', 'invariantRequiredFor']) {
    if (!Array.isArray(policy[field])) {
      return { verdict: VERDICT.unreadableInput, problems: [{ id: '-', message: `policy.${field} is missing` }] }
    }
  }

  const problems = []
  for (const [index, capability] of manifest.capabilities.entries()) {
    try {
      problems.push(...evaluateCapability(capability, index, policy))
    } catch (error) {
      // One unanticipated shape must not take the whole verdict down with it.
      return {
        verdict: VERDICT.verifierFailed,
        problems: [{ id: `#${index}`, message: `checker threw: ${error instanceof Error ? error.message : String(error)}` }]
      }
    }
  }
  problems.push(...evaluateEvidencePaths(manifest.capabilities, knownPath))

  // The ratchet: grandfathered unknowns may stay, new ones may not, and the list may only shrink.
  const grandfathered = new Set(baseline)
  const unknowns = manifest.capabilities
    .filter((capability) => isRecord(capability) && capability.disposition === 'unknown')
    .map((capability) => capability.id)
  for (const id of unknowns) {
    if (!grandfathered.has(id)) {
      problems.push({
        id,
        message:
          'new capability is unclassified for mobile. Give it a disposition, or add it to config/variant-parity-unknown-baseline.txt only if it predates this gate.'
      })
    }
  }
  const unknownSet = new Set(unknowns)
  for (const id of grandfathered) {
    if (!unknownSet.has(id)) {
      problems.push({
        id,
        message: `baseline lists ${id} as unclassified but the manifest no longer is. Remove it from the baseline -- the list may only shrink.`
      })
    }
  }

  return { verdict: problems.length === 0 ? VERDICT.ok : VERDICT.subjectInvalid, problems }
}

export function parseBaseline(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
}

async function main() {
  const root = process.cwd()
  let manifestText
  try {
    manifestText = await fs.readFile(path.join(root, MANIFEST_PATH), 'utf8')
  } catch {
    console.error(`variant parity: cannot read ${MANIFEST_PATH}`)
    return 2
  }

  const errors = []
  const manifest = parse(manifestText, errors, { allowTrailingComma: true })
  if (errors.length > 0) {
    const [first] = errors
    console.error(`variant parity: ${MANIFEST_PATH} is not valid JSONC (${printParseErrorCode(first.error)} at ${first.offset})`)
    return 2
  }

  let baseline = []
  try {
    baseline = parseBaseline(await fs.readFile(path.join(root, BASELINE_PATH), 'utf8'))
  } catch {
    // An absent baseline means nothing is grandfathered, which is stricter, never looser.
    baseline = []
  }

  const knownPath = (reference) => {
    try {
      // Synchronous existence via a resolved path keeps the predicate injectable for tests.
      return existsSync(path.join(root, reference))
    } catch {
      return false
    }
  }

  const { verdict, problems } = evaluateManifest({ manifest, baseline, knownPath })
  if (verdict === VERDICT.ok) {
    const counts = new Map()
    for (const capability of manifest.capabilities) {
      counts.set(capability.disposition, (counts.get(capability.disposition) ?? 0) + 1)
    }
    const summary = [...counts.entries()].map(([key, value]) => `${key}=${value}`).join(' ')
    console.log(`variant parity: ${manifest.capabilities.length} capabilities classified (${summary})`)
    return 0
  }

  console.error(`variant parity: ${verdict}`)
  for (const problem of problems) {
    console.error(`  ${problem.id}: ${problem.message}`)
  }
  return verdict === VERDICT.ok ? 0 : 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      console.error(`variant parity: checker failed: ${error instanceof Error ? error.stack : error}`)
      process.exitCode = 2
    })
}
