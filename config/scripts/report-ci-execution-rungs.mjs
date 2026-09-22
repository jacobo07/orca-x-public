import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

import { describeScope, readOriginUrlFromGit, resolveRepoScope } from './ci-repo-scope.mjs'

// A red icon in `gh run list` is not a test result. Between "a workflow exists" and "a gate
// failed" there are rungs, and GitHub reports the same `conclusion: failure` for most of them.
//
// Measured on this repository 2026-09-21: every run since 2026-09-13 01:51 UTC completed in
// 2-6 seconds having been assigned no runner and having started no step. Read as test failures
// they say the estate is broken; read correctly they say nothing about the estate at all.
//
// This is a REPORT, not a gate. It is deliberately not named check:* or verify:*, because it
// needs the network and an authenticated GitHub, so it can never be a merge condition, and
// check:ci-gate-coverage would otherwise be right to demand an executor for it.
//
// It is also out of band ON PURPOSE. A workflow cannot prove that no runner is available, because
// proving it would require a runner. Anything that answers this question has to run somewhere the
// answer does not depend on.

/** Rungs, lowest to highest. A run's verdict is the highest rung any of its jobs reached. */
export const RUNG = {
  RUN_CREATED: 'RUN_CREATED',
  RUNNER_ASSIGNED: 'RUNNER_ASSIGNED',
  STEP_STARTED: 'STEP_STARTED',
  VERDICT_OBSERVED: 'VERDICT_OBSERVED'
}

const RUNG_ORDER = [RUNG.RUN_CREATED, RUNG.RUNNER_ASSIGNED, RUNG.STEP_STARTED, RUNG.VERDICT_OBSERVED]

export const JOB_STATE = {
  /** A runner ran it and steps reported conclusions. Only here may `conclusion` be read as a verdict. */
  EXECUTED: 'EXECUTED',
  /** A runner was requested and never allocated. Not a failure of the subject. */
  EXECUTOR_UNAVAILABLE: 'EXECUTOR_UNAVAILABLE',
  /** An `if:` or an unmet `needs:` meant it was never supposed to run. Not a failure either. */
  CONDITION_SKIPPED: 'CONDITION_SKIPPED',
  /** Shape we have not seen. Never resolved toward the convenient reading. */
  UNKNOWN: 'UNKNOWN'
}

function stepCount(job) {
  return Array.isArray(job?.steps) ? job.steps.length : 0
}

/**
 * Classify one job from its API record.
 *
 * `runner_id` is the discriminating field and the three values are genuinely distinct:
 *   > 0    a machine ran this
 *   === 0  a machine was asked for and never arrived
 *   null   nothing was ever asked for, because the job was skipped
 *
 * Duration is NOT used. It is a proxy, and a poor one: a skipped job on this repository reports
 * completed_at BEFORE started_at (measured: secs = -1), and a genuinely fast job is
 * indistinguishable from a starved one by time alone.
 */
export function classifyJob(job) {
  if (!job || typeof job !== 'object') {
    return JOB_STATE.UNKNOWN
  }
  const runnerId = job.runner_id
  if (runnerId === null || runnerId === undefined) {
    return job.conclusion === 'skipped' ? JOB_STATE.CONDITION_SKIPPED : JOB_STATE.UNKNOWN
  }
  if (runnerId === 0) {
    return stepCount(job) === 0 ? JOB_STATE.EXECUTOR_UNAVAILABLE : JOB_STATE.UNKNOWN
  }
  if (typeof runnerId === 'number' && runnerId > 0) {
    return stepCount(job) > 0 ? JOB_STATE.EXECUTED : JOB_STATE.UNKNOWN
  }
  return JOB_STATE.UNKNOWN
}

function highestRungForJob(job) {
  switch (classifyJob(job)) {
    case JOB_STATE.EXECUTED:
      return job.steps.some((step) => step?.conclusion != null)
        ? RUNG.VERDICT_OBSERVED
        : RUNG.STEP_STARTED
    case JOB_STATE.EXECUTOR_UNAVAILABLE:
    case JOB_STATE.CONDITION_SKIPPED:
    case JOB_STATE.UNKNOWN:
    default:
      return RUNG.RUN_CREATED
  }
}

/**
 * The highest rung this run actually reached, plus why it stopped there.
 *
 * A run whose every non-skipped job was starved is BLOCKED, never FAILED. The distinction is the
 * whole point: one says fix your code, the other says find a machine.
 */
export function classifyRun(jobs) {
  const list = Array.isArray(jobs) ? jobs : []
  const states = list.map((job) => classifyJob(job))
  const highest = list.reduce((best, job) => {
    const rung = highestRungForJob(job)
    return RUNG_ORDER.indexOf(rung) > RUNG_ORDER.indexOf(best) ? rung : best
  }, RUNG.RUN_CREATED)

  const starved = states.filter((state) => state === JOB_STATE.EXECUTOR_UNAVAILABLE).length
  const executed = states.filter((state) => state === JOB_STATE.EXECUTED).length
  const skipped = states.filter((state) => state === JOB_STATE.CONDITION_SKIPPED).length
  const unknown = states.filter((state) => state === JOB_STATE.UNKNOWN).length

  let blocked = null
  if (executed === 0 && starved > 0) {
    // Deliberately not BILLING_EXHAUSTED. That is a claim about an account, and this function has
    // only ever looked at run metadata. Saying it here would turn an inference into a measurement.
    blocked = 'EXECUTOR_UNAVAILABLE'
  } else if (executed === 0 && unknown > 0) {
    blocked = 'UNKNOWN'
  } else if (executed === 0 && list.length > 0 && skipped === list.length) {
    blocked = 'ALL_JOBS_CONDITION_SKIPPED'
  } else if (list.length === 0) {
    blocked = 'NO_JOBS_REPORTED'
  }

  return { highestRung: highest, blocked, counts: { executed, starved, skipped, unknown } }
}

/** True only for a run whose conclusion may honestly be read as a statement about the code. */
export function verdictIsAboutTheCode(summary) {
  return summary?.highestRung === RUNG.VERDICT_OBSERVED
}

function gh(endpoint) {
  return JSON.parse(execFileSync('gh', ['api', endpoint], { encoding: 'utf8', maxBuffer: 32e6 }))
}

function main(argv) {
  const runIds = argv.filter((arg) => /^\d+$/.test(arg))
  if (runIds.length === 0) {
    console.error('usage: node config/scripts/report-ci-execution-rungs.mjs [--repo=owner/name] <runId>...')
    return 2
  }

  // This used to parse `--repo=` itself and require it. Two parsers for one question is two answers
  // waiting to diverge, so the canonical owner resolves the subject -- which also means this report
  // now derives the fork from `origin` rather than making the caller remember, and still refuses
  // rather than inheriting `gh`'s ambient default (which resolves to `upstream` here).
  let scope
  try {
    scope = resolveRepoScope({ argv, readOriginUrl: () => readOriginUrlFromGit() })
  } catch (error) {
    console.error(String(error.message ?? error))
    return 2
  }
  console.log(describeScope(scope))

  for (const runId of runIds) {
    const { jobs } = gh(`repos/${scope.repo}/actions/runs/${runId}/jobs`)
    const summary = classifyRun(jobs)
    const { executed, starved, skipped, unknown } = summary.counts
    console.log(
      `run ${runId}: ${summary.highestRung}` +
        `${summary.blocked ? ` (blocked: ${summary.blocked})` : ''} ` +
        `— ${executed} executed, ${starved} starved, ${skipped} skipped, ${unknown} unknown; ` +
        `conclusion ${verdictIsAboutTheCode(summary) ? 'IS' : 'is NOT'} a statement about the code`
    )
  }
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)))
}
