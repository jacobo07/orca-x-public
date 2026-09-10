import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

import { parse, printParseErrorCode } from 'jsonc-parser'

const MANIFEST_PATH = path.join('config', 'variant-parity.jsonc')
const BASELINE_PATH = path.join('config', 'variant-parity-unknown-baseline.txt')
const MEASURED_OPEN_BASELINE_PATH = path.join(
  'config',
  'variant-parity-measured-open-baseline.txt'
)

/** `--release` additionally fails the run when release-critical parity debt is open. */
const releaseMode = process.argv.includes('--release')

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
  // Severity is optional, but a value outside the policy is worse than none: the release gate reads
  // this field, and a typo would otherwise sail past as "not P0".
  if (capability.severity !== undefined && !policy.severities.includes(capability.severity)) {
    problems.push({
      id: where,
      message: `severity ${JSON.stringify(capability.severity)} is not one of ${policy.severities.join(', ')}`
    })
  }
  /**
   * A de-escalation has to argue itself.
   *
   * `unresolved` is protected by construction -- it sums both debt lists, so relabelling cannot move
   * it. `release-critical` had no such protection: it counts an untriaged capability as P0, so
   * typing a severity is by itself enough to make it fall, and nothing was required alongside. That
   * is the one number a release decision reads, and it was the cheapest to move. Measured on
   * 2026-09-10, four triages took it from 5 to 1 without a line of product code.
   *
   * So a claim that unresolved debt is NOT release-critical must say why, in its own field. This
   * cannot check that the argument is a good one; it can insist that someone had to write one down
   * where a reviewer will see it, which is the difference between a judgement and a keystroke.
   */
  if (
    Array.isArray(policy.unresolvedDispositions) &&
    policy.unresolvedDispositions.includes(disposition) &&
    capability.severity !== undefined &&
    capability.severity !== 'P0' &&
    !isNonEmptyString(capability.severityReason)
  ) {
    problems.push({
      id: where,
      message: `severity ${capability.severity} takes this unresolved capability out of the release gate and must carry severityReason saying why it is not P0`
    })
  }
  return problems
}

/**
 * One shrink-only list per unresolved disposition, checked in both directions: a new entry that
 * nobody acknowledged fails as new debt, and a listed id that is no longer in that state fails as a
 * stale exception.
 */
function evaluateRatchet(capabilities, disposition, grandfathered, newEntryHint) {
  const problems = []
  const ids = capabilities
    .filter((capability) => isRecord(capability) && capability.disposition === disposition)
    .map((capability) => capability.id)
  for (const id of ids) {
    if (!grandfathered.has(id)) {
      problems.push({ id, message: newEntryHint })
    }
  }
  const current = new Set(ids)
  for (const id of grandfathered) {
    if (!current.has(id)) {
      problems.push({
        id,
        message: `baseline lists ${id} as ${disposition} but the manifest no longer is. Remove it from the baseline -- the list may only shrink.`
      })
    }
  }
  return { ids, problems }
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

export function evaluateManifest({ manifest, baseline, measuredOpenBaseline = [], knownPath }) {
  if (!isRecord(manifest) || !isRecord(manifest.policy) || !Array.isArray(manifest.capabilities)) {
    return { verdict: VERDICT.unreadableInput, problems: [{ id: '-', message: 'manifest is missing policy or capabilities' }] }
  }
  const policy = manifest.policy
  for (const field of ['dispositions', 'evidenceRequiredFor', 'reasonRequiredFor', 'invariantRequiredFor', 'unresolvedDispositions', 'severities']) {
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

  const unknownGrandfathered = new Set(baseline)
  const measuredOpenGrandfathered = new Set(measuredOpenBaseline)
  const unknown = evaluateRatchet(
    manifest.capabilities,
    'unknown',
    unknownGrandfathered,
    'new capability is unclassified for mobile. Give it a disposition, or add it to config/variant-parity-unknown-baseline.txt only if it predates this gate.'
  )
  const measuredOpen = evaluateRatchet(
    manifest.capabilities,
    'measured-open',
    measuredOpenGrandfathered,
    'new measured gap. Acknowledge it in config/variant-parity-measured-open-baseline.txt -- a gap someone has measured is debt someone has to carry, and it may not appear silently.'
  )
  problems.push(...unknown.problems, ...measuredOpen.problems)

  // One capability, one kind of debt. Both lists are summed to report the unresolved total, so an id
  // in both would let a single gap pay for two rows of "progress" when it moves.
  for (const id of unknownGrandfathered) {
    if (measuredOpenGrandfathered.has(id)) {
      problems.push({
        id,
        message: `${id} is grandfathered in both baselines. A capability is unknown or measured-open, never both.`
      })
    }
  }

  /**
   * Two axes, deliberately not added together into one score.
   *
   * `unknown` is epistemic debt (nobody looked) and `measured-open` is implementation debt (someone
   * looked and named the gap). Moving a row from the first to the second is real progress and must
   * not read as a capability closing, so `unresolved` counts both and only falls when something is
   * actually resolved.
   *
   * An unresolved capability with no severity counts as P0. Absence is the least-capability answer:
   * forgetting to triage can only ever make the release gate stricter, never quieter.
   */
  const unresolvedIds = new Set([...unknown.ids, ...measuredOpen.ids])
  const p0Unresolved = manifest.capabilities
    .filter(
      (capability) =>
        isRecord(capability) &&
        unresolvedIds.has(capability.id) &&
        (capability.severity === undefined || capability.severity === 'P0')
    )
    .map((capability) => capability.id)
  const debt = {
    unknown: unknown.ids.length,
    measuredOpen: measuredOpen.ids.length,
    unresolved: unresolvedIds.size,
    p0Unresolved,
    releaseReady: p0Unresolved.length === 0
  }

  return { verdict: problems.length === 0 ? VERDICT.ok : VERDICT.subjectInvalid, problems, debt }
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

  // An absent baseline means nothing is grandfathered, which is stricter, never looser.
  const readBaseline = async (file) => {
    try {
      return parseBaseline(await fs.readFile(path.join(root, file), 'utf8'))
    } catch {
      return []
    }
  }
  const baseline = await readBaseline(BASELINE_PATH)
  const measuredOpenBaseline = await readBaseline(MEASURED_OPEN_BASELINE_PATH)

  const knownPath = (reference) => {
    try {
      // Synchronous existence via a resolved path keeps the predicate injectable for tests.
      return existsSync(path.join(root, reference))
    } catch {
      return false
    }
  }

  const { verdict, problems, debt } = evaluateManifest({
    manifest,
    baseline,
    measuredOpenBaseline,
    knownPath
  })
  if (verdict === VERDICT.ok) {
    const counts = new Map()
    for (const capability of manifest.capabilities) {
      counts.set(capability.disposition, (counts.get(capability.disposition) ?? 0) + 1)
    }
    const summary = [...counts.entries()].map(([key, value]) => `${key}=${value}`).join(' ')
    console.log(`variant parity: ${manifest.capabilities.length} capabilities classified (${summary})`)
    // Printed on every run, not only under --release: a debt total nobody sees is a debt total
    // nobody notices moving.
    console.log(
      `variant parity: unresolved=${debt.unresolved} (unknown=${debt.unknown} measured-open=${debt.measuredOpen}) release-critical=${debt.p0Unresolved.length}`
    )
    if (!releaseMode) {
      return 0
    }
    if (debt.releaseReady) {
      console.log('variant parity: no release-critical parity debt')
      return 0
    }
    console.error('variant parity: release-critical parity debt is open')
    for (const id of debt.p0Unresolved) {
      console.error(`  ${id}: unresolved and release-critical (P0, or untriaged and counted as P0)`)
    }
    return 1
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
