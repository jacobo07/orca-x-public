#!/usr/bin/env node
// Turns an AEOS remote run directory into a verdict, or refuses to.
//
// The rule this encodes: a log's text is never a verdict. On 2026-09-22
// `grep -c FAIL` over a remote suite log returned matches from test names and
// stderr while the count of real reporter FAIL blocks was zero -- and the run
// had been killed anyway. The verdict comes from the exit code plus the JSON
// reporter; the dot log is diagnostics and is never read here.
//
//   node config/scripts/aeos-remote-run-verdict.mjs <runDir>
//
// Exit: 0 PASS, 1 FAIL, 2 no verdict (the run says nothing about the subject).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const REMOTE_RUN_VERDICT = {
  manifestMissing: 'MANIFEST_MISSING',
  processTerminated: 'PROCESS_TERMINATED',
  budgetExceeded: 'BUDGET_EXCEEDED',
  harnessFailed: 'HARNESS_FAILED',
  inconclusive: 'INCONCLUSIVE',
  pass: 'PASS',
  fail: 'FAIL'
}

// Below this, a worker kill is plausible enough that a failure cannot be
// attributed to the code. Starvation can turn a pass into a failure; it cannot
// turn a failure into a pass -- so this gates FAIL only, never PASS.
export const DEFAULT_MEMORY_FLOOR_MB = 2048

const isBoundManifest = (manifest) =>
  Boolean(manifest && typeof manifest.sha === 'string' && manifest.sha.length >= 7 && manifest.host)

export function classifyRemoteRun({
  manifest = null,
  end = null,
  rc = null,
  report = null,
  memoryFloorMb = DEFAULT_MEMORY_FLOOR_MB
} = {}) {
  const evidence = {
    sha: manifest?.sha ?? null,
    host: manifest?.host ?? null,
    rc,
    signal: end?.signal || null,
    memAvailableAfterMb: end?.after?.memAvailableMb ?? null
  }
  const verdict = (v, reason, extra = {}) => ({ verdict: v, reason, evidence: { ...evidence, ...extra } })

  // Unbound evidence is not evidence: without a revision and a host, a result
  // describes nothing in particular.
  if (!isBoundManifest(manifest)) {
    return verdict(REMOTE_RUN_VERDICT.manifestMissing, 'no run manifest binding this result to a revision and a host')
  }
  // The trap writes rc last. Its absence means the process group was killed
  // before anything settled -- which is not a failing suite.
  if (rc === null || rc === undefined) {
    return verdict(
      REMOTE_RUN_VERDICT.processTerminated,
      'no exit code was recorded; the run was terminated before it could report'
    )
  }
  if (rc === 124 || rc === 137) {
    return verdict(REMOTE_RUN_VERDICT.budgetExceeded, `the run exceeded its wall-clock budget (rc ${rc})`)
  }

  const counts = readCounts(report)
  if (!counts) {
    return verdict(REMOTE_RUN_VERDICT.harnessFailed, 'the run exited but produced no readable JSON report')
  }
  // A run that collected nothing is not a passing run. Without this, an include
  // glob that matched zero files reports exactly what a clean suite reports.
  if (counts.total === 0) {
    return verdict(REMOTE_RUN_VERDICT.harnessFailed, 'the report contains zero tests; nothing was measured', counts)
  }
  // The exit code and the report are two instruments. When they disagree,
  // neither is reporting on the code.
  if ((rc === 0) !== (counts.failed === 0)) {
    return verdict(
      REMOTE_RUN_VERDICT.harnessFailed,
      `exit code ${rc} contradicts the report's ${counts.failed} failing test(s)`,
      counts
    )
  }

  if (counts.failed > 0) {
    const after = end?.after?.memAvailableMb
    if (typeof after === 'number' && after < memoryFloorMb) {
      return verdict(
        REMOTE_RUN_VERDICT.inconclusive,
        `${counts.failed} test(s) failed on a host with ${after} MB available; below ${memoryFloorMb} MB a failure cannot be attributed to the code`,
        counts
      )
    }
    return verdict(REMOTE_RUN_VERDICT.fail, `${counts.failed} of ${counts.total} tests failed`, counts)
  }
  return verdict(REMOTE_RUN_VERDICT.pass, `${counts.passed} of ${counts.total} tests passed`, counts)
}

function readCounts(report) {
  if (!report || typeof report !== 'object') return null
  const { numTotalTests: total, numPassedTests: passed, numFailedTests: failed } = report
  if (![total, passed, failed].every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  return { total, passed, failed }
}

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

export function readRemoteRun(runDir) {
  let rc = null
  try {
    const parsed = Number.parseInt(readFileSync(join(runDir, 'rc'), 'utf8').trim(), 10)
    rc = Number.isNaN(parsed) ? null : parsed
  } catch {
    rc = null
  }
  return {
    manifest: readJson(join(runDir, 'run.json')),
    end: readJson(join(runDir, 'run-end.json')),
    report: readJson(join(runDir, 'vitest.json')),
    rc
  }
}

export const exitCodeFor = (verdict) =>
  verdict === REMOTE_RUN_VERDICT.pass ? 0 : verdict === REMOTE_RUN_VERDICT.fail ? 1 : 2

// Why: `file://${argv[1]}` never equals import.meta.url on Windows, so this exited 0
// having classified nothing. The estate's tested helper compares real paths instead.
const { isEntryPoint } = await import('./check-mobile-capability-aperture.mjs')
if (isEntryPoint(process.argv[1], import.meta.filename)) {
  const runDir = process.argv[2]
  if (!runDir) {
    console.error('usage: aeos-remote-run-verdict.mjs <runDir>')
    process.exit(2)
  }
  const result = classifyRemoteRun(readRemoteRun(runDir))
  console.log(JSON.stringify({ runDir, ...result }, null, 2))
  process.exit(exitCodeFor(result.verdict))
}
