import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

import { parse, printParseErrorCode } from 'jsonc-parser'

import {
  ASSERTION_BASELINE_PATH,
  createAssertionSourceReader,
  extractBaselineHeader,
  parseAssertionBaseline,
  pruneBaseline,
  resolveGateAssertions
} from './reliability-assertion-resolution.mjs'

const MANIFEST_PATH = path.join('config', 'reliability-gates.jsonc')
const RED_GREEN_STATUSES = new Set(['missing', 'partial', 'complete', 'not-required'])
const FLAKE_STATUSES = new Set(['not-started', 'unknown', 'soaking', 'stable', 'flaky'])
const PROTECTION_LEVELS = new Set(['none', 'partial', 'active'])
const EVIDENCE_RUN_RESULTS = new Set(['passed', 'failed', 'skipped'])
const EVIDENCE_RUNNERS = new Set(['local', 'ci', 'soak', 'manual'])

const ACTIONS_RUN_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/

/**
 * `runner: "ci"` claims recorded before provenance was required.
 *
 * This file's header already says evidenceRuns is declared, not verified. For local, soak and
 * manual runs that is unavoidable: nothing outside this repository witnessed them. A CI run is
 * different -- GitHub holds the record, so a run URL turns "a developer says they ran it" into
 * something a reader can open, and it is the only runner value where the claim is checkable at all.
 *
 * Why it matters here specifically: measured 2026-09-21, this repository has not been assigned a
 * GitHub-hosted runner since 2026-09-13 01:51 UTC. Every run created since then finished in
 * seconds with no runner and no steps. In that world a `ci` claim is not merely unverified, it is
 * the one claim that has become impossible to honestly make, and nothing in the schema noticed.
 *
 * These three predate the requirement and are real -- all were recorded well before the runner
 * stopped. The list may only SHRINK: add a runUrl and delete the entry. A new ci claim must carry
 * provenance, and an entry whose run has since gained one is stale and fails the check.
 */
export const CI_EVIDENCE_WITHOUT_PROVENANCE = new Set([
  'browser-stream.bounded-reconnect::2026-08-07',
  'terminal-session.daemon-generation-reconnect-safety::2026-07-27',
  'terminal-session.windows-main-crash-survival::2026-07-18'
])

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function hasNonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString)
}

function requireNonEmptyString(gate, field, failures) {
  if (!isNonEmptyString(gate[field])) {
    failures.push(`${gate.id ?? '<unknown>'}: ${field} must be a non-empty string`)
  }
}

function requireStringArray(gate, field, failures) {
  if (!hasNonEmptyStringArray(gate[field])) {
    failures.push(`${gate.id ?? '<unknown>'}: ${field} must be a non-empty string array`)
  }
}

function requireStringArrayAllowEmpty(gate, field, failures) {
  if (!Array.isArray(gate[field]) || !gate[field].every(isNonEmptyString)) {
    failures.push(`${gate.id ?? '<unknown>'}: ${field} must be an array of strings`)
  }
}

function requireNonNegativeNumber(record, field, owner, failures) {
  if (!Number.isFinite(record[field]) || record[field] < 0) {
    failures.push(`${owner}.${field} must be a non-negative number`)
  }
}

function validatePolicy(manifest, failures) {
  if (!isRecord(manifest.policy)) {
    failures.push('policy must be an object')
    return new Set()
  }
  if (!hasNonEmptyStringArray(manifest.policy.maturityLevels)) {
    failures.push('policy.maturityLevels must be a non-empty string array')
  }
  if (!isRecord(manifest.policy.blockingPromotion)) {
    failures.push('policy.blockingPromotion must be an object')
  } else {
    for (const field of ['minimumSoakRuns', 'minimumSoakDays', 'maximumUnexplainedFlakes']) {
      requireNonNegativeNumber(
        manifest.policy.blockingPromotion,
        field,
        'policy.blockingPromotion',
        failures
      )
    }
  }
  return new Set(
    Array.isArray(manifest.policy.maturityLevels)
      ? manifest.policy.maturityLevels.filter(isNonEmptyString)
      : []
  )
}

function validateRuntimeBudget(gate, failures) {
  if (!isRecord(gate.runtimeBudget)) {
    failures.push(`${gate.id}: runtimeBudget must be an object`)
    return
  }
  if (!Number.isFinite(gate.runtimeBudget.p95Seconds) || gate.runtimeBudget.p95Seconds <= 0) {
    failures.push(`${gate.id}: runtimeBudget.p95Seconds must be a positive number`)
  }
  if (!isNonEmptyString(gate.runtimeBudget.scope)) {
    failures.push(`${gate.id}: runtimeBudget.scope must be a non-empty string`)
  }
}

function validateEvidence(gate, field, allowedStatuses, failures) {
  const evidence = gate[field]
  if (!isRecord(evidence)) {
    failures.push(`${gate.id}: ${field} must be an object`)
    return
  }
  if (!allowedStatuses.has(evidence.status)) {
    failures.push(`${gate.id}: ${field}.status is invalid`)
  }
  if (!isNonEmptyString(evidence.evidence)) {
    failures.push(`${gate.id}: ${field}.evidence must be a non-empty string`)
  }
}

function validatePerformanceBudget(gate, failures) {
  if (!isRecord(gate.performanceBudget)) {
    failures.push(`${gate.id}: performanceBudget must be an object`)
    return
  }
  if (typeof gate.performanceBudget.required !== 'boolean') {
    failures.push(`${gate.id}: performanceBudget.required must be boolean`)
  }
  if (!isNonEmptyString(gate.performanceBudget.evidence)) {
    failures.push(`${gate.id}: performanceBudget.evidence must be a non-empty string`)
  }
}

function commandUsesBrittleTestSelector(command) {
  return /(?:^|\s)(?:-t|--testNamePattern|--grep)(?:=|\s)/.test(command)
}

function validateCommandCoverage(gate, failures) {
  if (!hasNonEmptyStringArray(gate.commands) || !hasNonEmptyStringArray(gate.testFiles)) {
    return
  }
  for (const testFile of gate.testFiles) {
    if (!gate.commands.some((command) => command.includes(testFile))) {
      failures.push(`${gate.id}: test file is not referenced by any gate command: ${testFile}`)
    }
  }
}

function validateProtection(gate, failures) {
  if (!PROTECTION_LEVELS.has(gate.protection)) {
    failures.push(`${gate.id}: protection must be one of none, partial, or active`)
    return
  }
  const hasCommands = hasNonEmptyStringArray(gate.commands)
  const hasTestFiles = hasNonEmptyStringArray(gate.testFiles)
  if (gate.protection === 'none' && (hasCommands || hasTestFiles)) {
    failures.push(`${gate.id}: protection none gates must not declare commands or testFiles`)
  }
  if (gate.protection === 'partial' && (!hasCommands || !hasTestFiles)) {
    failures.push(`${gate.id}: protection partial gates must declare commands and testFiles`)
  }
  if (gate.protection === 'active') {
    if (gate.maturity !== 'blocking') {
      failures.push(`${gate.id}: protection active is reserved for blocking gates`)
    }
    if (!hasCommands || !hasTestFiles) {
      failures.push(`${gate.id}: protection active gates must declare commands and testFiles`)
    }
    if (gate.flakeHistory?.status !== 'stable') {
      failures.push(`${gate.id}: protection active gates must have stable flakeHistory`)
    }
    if (!hasCompleteRedGreenEvidence(gate)) {
      failures.push(`${gate.id}: protection active gates must have complete red/green evidence`)
    }
  }
  if (!hasCommands && gate.protection !== 'none') {
    failures.push(`${gate.id}: commandless gates must declare protection none`)
  }
}

function isIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

// Why: cross-field validators run even after an earlier type check flagged a
// malformed field, so coerce to an array before `.includes` to report the error
// instead of throwing on hand-edited manifests.
function asArray(value) {
  return Array.isArray(value) ? value : []
}

function hasCompleteRedGreenEvidence(gate) {
  return ['complete', 'not-required'].includes(gate.redGreenEvidence?.status)
}

function validateEvidenceRun(gate, run, index, failures) {
  const owner = `${gate.id}: evidenceRuns[${index}]`
  if (!isRecord(run)) {
    failures.push(`${owner} must be an object`)
    return
  }
  if (!isIsoDate(run.date)) {
    failures.push(`${owner}.date must be YYYY-MM-DD`)
  }
  if (!EVIDENCE_RUNNERS.has(run.runner)) {
    failures.push(`${owner}.runner must be one of local, ci, soak, or manual`)
  }
  if (
    run.runner === 'ci' &&
    !CI_EVIDENCE_WITHOUT_PROVENANCE.has(`${gate.id}::${run.date}`) &&
    !ACTIONS_RUN_URL.test(run.runUrl ?? '')
  ) {
    failures.push(
      `${owner}.runUrl must be a GitHub Actions run URL (https://github.com/<owner>/<repo>/actions/runs/<id>): ` +
        'a ci claim with no run id cannot be told apart from a local run somebody labelled ci'
    )
  }
  if (!isNonEmptyString(run.platform)) {
    failures.push(`${owner}.platform must be a non-empty string`)
  }
  if (!EVIDENCE_RUN_RESULTS.has(run.result)) {
    failures.push(`${owner}.result must be one of passed, failed, or skipped`)
  }
  if (!isNonEmptyString(run.command)) {
    failures.push(`${owner}.command must be a non-empty string`)
  } else if (!asArray(gate.commands).includes(run.command)) {
    failures.push(`${owner}.command must match one of the gate commands`)
  }
  if (!Number.isFinite(run.durationSeconds) || run.durationSeconds < 0) {
    failures.push(`${owner}.durationSeconds must be a non-negative number`)
  }
  if (!isNonEmptyString(run.summary)) {
    failures.push(`${owner}.summary must be a non-empty string`)
  }
}

function validateEvidenceRuns(gate, failures) {
  if (!Array.isArray(gate.evidenceRuns)) {
    failures.push(`${gate.id}: evidenceRuns must be an array`)
    return
  }
  gate.evidenceRuns.forEach((run, index) => validateEvidenceRun(gate, run, index, failures))
  if (
    ['partial', 'active'].includes(gate.protection) &&
    !gate.evidenceRuns.some((run) => isRecord(run) && run.result === 'passed')
  ) {
    failures.push(`${gate.id}: protection ${gate.protection} gates need a passed evidence run`)
  }
  if (gate.protection === 'none' && gate.evidenceRuns.length > 0) {
    failures.push(`${gate.id}: protection none gates must not declare evidenceRuns`)
  }
}

function validateAssertionRef(gate, ref, index, failures) {
  const owner = `${gate.id}: assertionRefs[${index}]`
  if (!isRecord(ref)) {
    failures.push(`${owner} must be an object`)
    return
  }
  if (!isNonEmptyString(ref.file)) {
    failures.push(`${owner}.file must be a non-empty string`)
  } else if (!asArray(gate.testFiles).includes(ref.file)) {
    failures.push(`${owner}.file must be one of the gate testFiles`)
  }
  if (!hasNonEmptyStringArray(ref.assertions)) {
    failures.push(`${owner}.assertions must be a non-empty string array`)
  }
}

function validateAssertionRefs(gate, failures) {
  if (!Array.isArray(gate.assertionRefs)) {
    failures.push(`${gate.id}: assertionRefs must be an array`)
    return
  }
  gate.assertionRefs.forEach((ref, index) => validateAssertionRef(gate, ref, index, failures))
  if (['partial', 'active'].includes(gate.protection) && gate.assertionRefs.length === 0) {
    failures.push(`${gate.id}: protection ${gate.protection} gates need assertionRefs`)
  }
  if (gate.protection === 'none' && gate.assertionRefs.length > 0) {
    failures.push(`${gate.id}: protection none gates must not declare assertionRefs`)
  }
}

function validateCoveredScope(gate, failures) {
  requireStringArrayAllowEmpty(gate, 'coveredPlatforms', failures)
  requireStringArrayAllowEmpty(gate, 'coveredProviders', failures)
  requireNonEmptyString(gate, 'coverageNotes', failures)

  if (!Array.isArray(gate.coveredPlatforms) || !Array.isArray(gate.coveredProviders)) {
    return
  }
  for (const platform of gate.coveredPlatforms) {
    if (!asArray(gate.platforms).includes(platform)) {
      failures.push(`${gate.id}: covered platform is outside risk scope: ${platform}`)
    }
  }
  for (const provider of gate.coveredProviders) {
    if (!asArray(gate.providers).includes(provider)) {
      failures.push(`${gate.id}: covered provider is outside risk scope: ${provider}`)
    }
  }
  if (
    ['partial', 'active'].includes(gate.protection) &&
    asArray(gate.evidenceRuns).some((run) => isRecord(run) && run.result === 'passed')
  ) {
    const evidencePlatforms = new Set(
      asArray(gate.evidenceRuns)
        .filter((run) => isRecord(run) && run.result === 'passed')
        .map((run) => run.platform)
    )
    for (const platform of evidencePlatforms) {
      if (!gate.coveredPlatforms.includes(platform)) {
        failures.push(
          `${gate.id}: coveredPlatforms must include passed evidence platform ${platform}`
        )
      }
    }
  }
  if (
    gate.protection === 'none' &&
    (gate.coveredPlatforms.length > 0 || gate.coveredProviders.length > 0)
  ) {
    failures.push(`${gate.id}: protection none gates must not declare covered scope`)
  }
}

async function fileExists(root, filePath) {
  try {
    const stat = await fs.stat(path.join(root, filePath))
    return stat.isFile()
  } catch {
    return false
  }
}

/**
 * A gate must resolve every assertion it claims, unless it is carrying recorded legacy debt.
 *
 * Three outcomes, and the third is what keeps the ratchet turning: unrecorded debt is refused so
 * new work cannot add unverifiable evidence, a recorded count may only shrink, and a gate that has
 * been fixed must be pruned from the baseline or the list becomes a permanent excuse.
 */
async function validateAssertionResolution(gate, readSource, baseline, failures) {
  const resolution = await resolveGateAssertions(gate, readSource)
  if (resolution.unreadable > 0) {
    failures.push(
      `${gate.id}: ${resolution.unreadable} assertionRef(s) name a file that could not be read`
    )
  }
  const recorded = baseline.get(gate.id)
  if (resolution.unresolved > 0) {
    const shown = resolution.missing[0]
    if (recorded === undefined) {
      failures.push(
        `${gate.id}: ${resolution.unresolved} claimed assertion(s) do not appear in the files cited; ` +
          `use the real test title (first: ${shown.file} -> "${shown.assertion}")`
      )
    } else if (resolution.unresolved > recorded) {
      failures.push(
        `${gate.id}: unverifiable assertion evidence grew from ${recorded} to ${resolution.unresolved}; ` +
          `${ASSERTION_BASELINE_PATH} may only shrink`
      )
    }
    return
  }
  if (recorded !== undefined) {
    failures.push(
      `${gate.id}: every claimed assertion now resolves, so its ${ASSERTION_BASELINE_PATH} entry is stale; ` +
        `remove it (pnpm check:reliability-gates --prune)`
    )
  }
}

async function validateGate(gate, maturities, root, readSource, baseline) {
  const failures = []
  if (!isRecord(gate)) {
    return ['gate entry must be an object']
  }
  for (const field of ['id', 'title', 'owner', 'layer', 'invariant', 'oracle', 'demotionRule']) {
    requireNonEmptyString(gate, field, failures)
  }
  if (!maturities.has(gate.maturity)) {
    failures.push(`${gate.id ?? '<unknown>'}: maturity is invalid`)
  }
  for (const field of [
    'surfaces',
    'platforms',
    'providers',
    'motivatingLinks',
    'promotionCriteria'
  ]) {
    requireStringArray(gate, field, failures)
  }
  if (!Array.isArray(gate.commands) || !gate.commands.every(isNonEmptyString)) {
    failures.push(`${gate.id}: commands must be an array of strings`)
  } else if (gate.commands.some(commandUsesBrittleTestSelector)) {
    failures.push(
      `${gate.id}: commands must not rely on title selectors (-t, --grep, or --testNamePattern)`
    )
  }
  if (!Array.isArray(gate.testFiles) || !gate.testFiles.every(isNonEmptyString)) {
    failures.push(`${gate.id}: testFiles must be an array of strings`)
  } else {
    for (const testFile of gate.testFiles) {
      if (!(await fileExists(root, testFile))) {
        failures.push(`${gate.id}: test file does not exist: ${testFile}`)
      }
    }
  }
  validateCommandCoverage(gate, failures)
  if (['soak', 'blocking'].includes(gate.maturity)) {
    if (!hasNonEmptyStringArray(gate.commands)) {
      failures.push(`${gate.id}: ${gate.maturity} gates must declare at least one command`)
    }
    if (!hasNonEmptyStringArray(gate.testFiles)) {
      failures.push(`${gate.id}: ${gate.maturity} gates must declare at least one test file`)
    }
    if (!['soaking', 'stable'].includes(gate.flakeHistory?.status)) {
      failures.push(`${gate.id}: ${gate.maturity} gates must have soaking or stable flakeHistory`)
    }
    if (!hasCompleteRedGreenEvidence(gate)) {
      failures.push(`${gate.id}: ${gate.maturity} gates must have complete red/green evidence`)
    }
  }
  validateRuntimeBudget(gate, failures)
  validateEvidence(gate, 'flakeHistory', FLAKE_STATUSES, failures)
  validateEvidence(gate, 'redGreenEvidence', RED_GREEN_STATUSES, failures)
  validateProtection(gate, failures)
  validateEvidenceRuns(gate, failures)
  validateAssertionRefs(gate, failures)
  await validateAssertionResolution(gate, readSource, baseline, failures)
  validateCoveredScope(gate, failures)
  validatePerformanceBudget(gate, failures)
  if (!Array.isArray(gate.knownGaps) || !gate.knownGaps.every(isNonEmptyString)) {
    failures.push(`${gate.id}: knownGaps must be an array of strings`)
  }
  return failures
}

export const VERDICT_CONTRACT_VALID = 'CONTRACT VALID'
export const VERDICT_CONTRACT_INVALID = 'CONTRACT INVALID'
export const VERDICT_UNREADABLE_INPUT = 'UNREADABLE INPUT'
export const VERDICT_CHECKER_INTERNAL_FAILURE = 'CHECKER INTERNAL FAILURE'

/**
 * Validate every gate, isolating a validator that throws. A thrown validator means the checker
 * could not judge that gate — a different fact from the gate being invalid, and separated here so
 * one unanticipated field shape cannot take down the verdict for the whole manifest.
 */
export async function validateManifest(manifest, root) {
  const failures = []
  const internalFailures = []
  if (!isRecord(manifest)) {
    failures.push('manifest must be an object')
    return { failures, internalFailures }
  }
  // Why an absent baseline is empty rather than fatal: every gate must then resolve its own
  // assertions, which is the strict direction. A baseline we cannot PARSE is different -- that is
  // the checker failing to judge, not the manifest being wrong, so it outranks as exit 2.
  let baseline = new Map()
  try {
    baseline = parseAssertionBaseline(
      await fs.readFile(path.join(root, ASSERTION_BASELINE_PATH), 'utf8')
    )
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      internalFailures.push(`the checker could not read the assertion baseline (${error.message})`)
      return { failures, internalFailures }
    }
  }
  const readSource = createAssertionSourceReader(root)
  await readSource.prefetch(
    (Array.isArray(manifest.gates) ? manifest.gates : [])
      .flatMap((gate) =>
        isRecord(gate) && Array.isArray(gate.assertionRefs) ? gate.assertionRefs : []
      )
      .map((ref) => (isRecord(ref) ? ref.file : null))
      .filter(isNonEmptyString)
  )
  if (manifest.schemaVersion !== 1) {
    failures.push('schemaVersion must be 1')
  }
  const maturities = validatePolicy(manifest, failures)
  if (!Array.isArray(manifest.gates) || manifest.gates.length === 0) {
    failures.push('gates must be a non-empty array')
    return { failures, internalFailures }
  }
  const seenIds = new Set()
  for (const gate of manifest.gates) {
    const gateId = isRecord(gate) && isNonEmptyString(gate.id) ? gate.id : '<unknown>'
    if (isRecord(gate) && isNonEmptyString(gate.id)) {
      if (seenIds.has(gate.id)) {
        failures.push(`${gate.id}: duplicate gate id`)
      }
      seenIds.add(gate.id)
    }
    try {
      failures.push(...(await validateGate(gate, maturities, root, readSource, baseline)))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      internalFailures.push(`${gateId}: the checker threw while validating this gate (${message})`)
    }
  }
  for (const stale of findStaleProvenanceExemptions(manifest)) {
    failures.push(
      `${stale}: exempted from ci evidence provenance, but no ci run without a runUrl matches it ` +
        'any more; remove the stale entry from CI_EVIDENCE_WITHOUT_PROVENANCE'
    )
  }
  return { failures, internalFailures }
}

/**
 * An exemption may not outlive its debt.
 *
 * Without this the frozen list becomes a permanent excuse: a run could gain provenance, or be
 * deleted outright, and the entry would sit there describing nothing while still granting a pass
 * to whatever later occupied that (gate, date) pair.
 */
export function findStaleProvenanceExemptions(manifest) {
  const gateIds = new Set()
  const unproven = new Set()
  for (const gate of Array.isArray(manifest?.gates) ? manifest.gates : []) {
    try {
      if (!isRecord(gate) || !isNonEmptyString(gate.id)) {
        continue
      }
      gateIds.add(gate.id)
      for (const run of Array.isArray(gate.evidenceRuns) ? gate.evidenceRuns : []) {
        if (isRecord(run) && run.runner === 'ci' && !ACTIONS_RUN_URL.test(run.runUrl ?? '')) {
          unproven.add(`${gate.id}::${run.date}`)
        }
      }
    } catch {
      // A gate whose fields cannot be read is already reported by validateGate as a checker
      // failure against that gate. Letting it escape here would turn one unreadable gate into a
      // verdict about the whole manifest, which is the isolation this file exists to keep.
    }
  }
  // Only judge an exemption against a manifest that actually contains its gate. The frozen list
  // describes THIS repository's manifest; a synthetic one in a test contains none of those gates,
  // and reading their absence as "the debt is settled" would fail every fixture that has nothing
  // to do with provenance. The real manifest is pinned by a test instead.
  return [...CI_EVIDENCE_WITHOUT_PROVENANCE]
    .filter((key) => gateIds.has(key.slice(0, key.lastIndexOf('::'))) && !unproven.has(key))
    .sort()
}

/**
 * A checker that cannot judge its subject and a subject that failed judgement are both non-success,
 * and they are not the same evidence. Exit 1 rejects the manifest; exit 2 says the manifest was not
 * fully judged and the run proves nothing about it.
 */
export function resolveVerdict({ failures, internalFailures }) {
  if (internalFailures.length > 0) {
    return { verdict: VERDICT_CHECKER_INTERNAL_FAILURE, code: 2 }
  }
  if (failures.length > 0) {
    return { verdict: VERDICT_CONTRACT_INVALID, code: 1 }
  }
  return { verdict: VERDICT_CONTRACT_VALID, code: 0 }
}

/**
 * Rewrite the baseline from measured reality, dropping gates that now resolve and lowering counts
 * that have fallen. Refuses to record anything new, so this cannot become the way debt is added.
 */
async function pruneAssertionBaseline(manifest, root) {
  const baselinePath = path.join(root, ASSERTION_BASELINE_PATH)
  let existing
  try {
    existing = await fs.readFile(baselinePath, 'utf8')
  } catch (error) {
    console.error(`${ASSERTION_BASELINE_PATH}: unable to read (${error.message})`)
    return 1
  }
  const readSource = createAssertionSourceReader(root)
  await readSource.prefetch(
    (Array.isArray(manifest.gates) ? manifest.gates : [])
      .flatMap((gate) =>
        isRecord(gate) && Array.isArray(gate.assertionRefs) ? gate.assertionRefs : []
      )
      .map((ref) => (isRecord(ref) ? ref.file : null))
      .filter(isNonEmptyString)
  )
  const measured = new Map()
  for (const gate of Array.isArray(manifest.gates) ? manifest.gates : []) {
    if (!isRecord(gate) || !isNonEmptyString(gate.id)) {
      continue
    }
    const { unresolved } = await resolveGateAssertions(gate, readSource)
    if (unresolved > 0) {
      measured.set(gate.id, unresolved)
    }
  }
  const recorded = parseAssertionBaseline(existing)
  const { kept, refused } = pruneBaseline(recorded, measured)
  if (refused.length > 0) {
    console.error('Refusing to prune: that would record new unverifiable assertion evidence.')
    for (const line of refused) {
      console.error(`- ${line}`)
    }
    return 1
  }
  await fs.writeFile(baselinePath, `${extractBaselineHeader(existing)}${kept.join('\n')}\n`, 'utf8')
  console.log(
    `${ASSERTION_BASELINE_PATH}: ${recorded.size} entr(ies) -> ${kept.length} after pruning.`
  )
  return 0
}

export async function main(root = process.cwd()) {
  const manifestPath = path.join(root, MANIFEST_PATH)
  let raw
  try {
    raw = await fs.readFile(manifestPath, 'utf8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`${MANIFEST_PATH}: unable to read manifest (${message})`)
    console.error(`Verdict: ${VERDICT_UNREADABLE_INPUT}`)
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
    console.error(`Verdict: ${VERDICT_UNREADABLE_INPUT}`)
    return 1
  }
  if (process.argv.includes('--prune')) {
    return await pruneAssertionBaseline(manifest, root)
  }
  let result
  try {
    result = await validateManifest(manifest, root)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`The checker failed before it could judge the manifest (${message})`)
    console.error(`Verdict: ${VERDICT_CHECKER_INTERNAL_FAILURE}`)
    return 2
  }
  const { verdict, code } = resolveVerdict(result)
  if (result.failures.length > 0) {
    console.error(`Reliability gate manifest check failed with ${result.failures.length} issue(s):`)
    for (const failure of result.failures) {
      console.error(`- ${failure}`)
    }
  }
  if (result.internalFailures.length > 0) {
    console.error(
      `The checker could not judge ${result.internalFailures.length} gate(s); this run proves nothing about them:`
    )
    for (const failure of result.internalFailures) {
      console.error(`- ${failure}`)
    }
  }
  if (code === 0) {
    console.log(`Reliability gate manifest check passed for ${manifest.gates.length} gate(s).`)
    return 0
  }
  console.error(`Verdict: ${verdict}`)
  return code
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main())
}
