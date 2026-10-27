import { RUNG } from './report-ci-execution-rungs.mjs'

// The repository is captured: a well-formed URL naming another repository's run is still not
// evidence about this one. See findCiEvidenceAttributionFailures.
export const ACTIONS_RUN_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/actions\/runs\/\d+$/

/**
 * `runner: "ci"` claims recorded before provenance was required.
 *
 * This file's header already says evidenceRuns is declared, not verified. For local, soak and
 * manual runs that is unavoidable: nothing outside this repository witnessed them. A CI run is
 * different -- GitHub holds the record, so a run URL turns "a developer says they ran it" into
 * something a reader can open, and it is the only runner value where the claim is checkable at all.
 *
 * Why it matters here specifically: measured 2026-09-21, this repository has not been assigned a
 * GitHub-hosted runner since 2026-09-13T10:43:50Z (first starved run; the earlier "01:51 UTC" was
 * CEST wall-clock -- see config/ci-runner-recovery-contract.jsonc). Every run created since then finished in
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

/**
 * A ci run URL proves a run happened. It proves neither that the run was about THIS repository nor
 * that it executed anything, and on this fork both have failed:
 *
 * - `upstream` is alive, so a URL naming stablyai/orca is well-formed, opens, and shows a real
 *   verdict -- about somebody else's code.
 * - Since the 2026-09-13 starvation every run here completes in seconds with no runner. Its URL is
 *   valid and its `failure` says nothing about any gate.
 *
 * So a ci run with a URL must name the subject repository and declare the highest rung it reached,
 * which `pnpm report:ci-execution-rungs <runId>` prints. Only VERDICT_OBSERVED is evidence.
 *
 * The subject is resolved only when there is a URL to judge. A subject that cannot be resolved is
 * the checker failing to judge, reported as such -- never a manifest failure, never a default.
 */
export function findCiEvidenceAttributionFailures(manifest, resolveSubjectRepo) {
  const claims = []
  const gates = isRecord(manifest) && Array.isArray(manifest.gates) ? manifest.gates : []
  for (const gate of gates) {
    if (!isRecord(gate)) {
      continue
    }
    // Isolated per gate, like validateGate: a field that throws on access must not take down the
    // verdict for every other gate. That gate is already reported as one the checker could not
    // judge, so it is skipped here rather than reported twice.
    let runs
    try {
      runs = Array.isArray(gate.evidenceRuns) ? gate.evidenceRuns : []
    } catch {
      continue
    }
    runs.forEach((run, index) => {
      const match =
        isRecord(run) && run.runner === 'ci' ? ACTIONS_RUN_URL.exec(run.runUrl ?? '') : null
      if (match) {
        claims.push({ owner: `${gate.id}: evidenceRuns[${index}]`, run, repo: match[1] })
      }
    })
  }
  if (claims.length === 0) {
    return { failures: [], internalFailure: null }
  }
  let subject
  try {
    subject = resolveSubjectRepo()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      failures: [],
      internalFailure: `the checker could not tell which repository ci evidence must be about (${message})`
    }
  }
  const failures = []
  for (const { owner, run, repo } of claims) {
    if (repo.toLowerCase() !== String(subject).toLowerCase()) {
      failures.push(
        `${owner}.runUrl names ${repo}, but this manifest's evidence is about ${subject}: ` +
          "another repository's run is not evidence here"
      )
    }
    if (run.highestRung !== RUNG.VERDICT_OBSERVED) {
      failures.push(
        `${owner}.highestRung must be ${RUNG.VERDICT_OBSERVED}: a run assigned no runner, or with ` +
          'no step conclusion, says nothing about this gate (classify it with ' +
          'pnpm report:ci-execution-rungs <runId>)'
      )
    }
  }
  return { failures, internalFailure: null }
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
