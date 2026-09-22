import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

import { JOB_STATE, classifyJob } from './report-ci-execution-rungs.mjs'
import { describeScope, readOriginUrlFromGit, resolveRepoScope } from './ci-repo-scope.mjs'

// One question: HAS EXECUTION CAPACITY RETURNED FOR THIS REPOSITORY?
//
// report-ci-execution-rungs.mjs answers it for runs you already name. It cannot answer it for the
// repository, because "did our runners come back?" is a question about a WINDOW -- you have to look
// at what was created since capacity disappeared and ask whether any of it reached a machine.
//
// Classification is NOT reimplemented here. `classifyJob` is imported, so there is exactly one
// definition of what a starved job looks like, and the two reports can never drift into disagreeing
// about the same job. This file owns the window, the verdict and the attribution; nothing else.
//
// Like its sibling this is a REPORT, not a gate: it needs the network and an authenticated GitHub,
// so it can never be a merge condition. It is also out of band on purpose -- a workflow cannot prove
// that no runner is available, because proving it would require a runner.

/** The moment this repository's runs stopped reaching a machine. Owned by the recovery contract. */
export const STARVATION_BOUNDARY = '2026-09-13T01:51:00Z'

export const CAPACITY = {
  /** A job after the boundary ran on a real machine. The only verdict that ends the incident. */
  RESTORED: 'RESTORED',
  /** Jobs were created after the boundary, asked for a machine, and none arrived. */
  NOT_RESTORED: 'NOT_RESTORED',
  /** The evidence cannot discriminate. Never resolved toward either confident answer. */
  UNKNOWN: 'UNKNOWN'
}

/**
 * Decide from already-fetched evidence, so the verdict is testable without a network.
 *
 * `runs` is [{ id, name, createdAt, jobs }]. `jobs` MUST be null when the jobs endpoint could not be
 * read -- an unreadable run is a hole in the evidence, and a hole is never a starved job. That
 * distinction is the whole reason this takes data rather than fetching it inline.
 */
export function classifyCapacity({ runs, boundary = STARVATION_BOUNDARY } = {}) {
  const cutoff = Date.parse(boundary)
  if (!Number.isFinite(cutoff)) {
    return unknown('the starvation boundary is not a readable timestamp', { examined: 0 })
  }

  const list = Array.isArray(runs) ? runs : []
  const after = list.filter((run) => {
    const created = Date.parse(run?.createdAt ?? '')
    return Number.isFinite(created) && created >= cutoff
  })

  if (after.length === 0) {
    return unknown(`no runs were created after ${boundary}, so nothing has asked for a machine`, {
      examined: 0
    })
  }

  const unreadable = after.filter((run) => !Array.isArray(run.jobs))
  const readable = after.filter((run) => Array.isArray(run.jobs))
  const counts = { executed: 0, starved: 0, skipped: 0, unknown: 0 }
  let firstExecuted = null

  for (const run of readable) {
    for (const job of run.jobs) {
      switch (classifyJob(job)) {
        case JOB_STATE.EXECUTED:
          counts.executed += 1
          firstExecuted ??= { run, job }
          break
        case JOB_STATE.EXECUTOR_UNAVAILABLE:
          counts.starved += 1
          break
        case JOB_STATE.CONDITION_SKIPPED:
          counts.skipped += 1
          break
        default:
          counts.unknown += 1
      }
    }
  }

  const evidence = { examined: after.length, unreadable: unreadable.length, counts }

  // Positive evidence wins outright, and it is the only thing that can. A single job on a real
  // runner proves a machine was available; no quantity of starved jobs can un-prove it.
  if (counts.executed > 0) {
    return {
      verdict: CAPACITY.RESTORED,
      reason:
        `run ${firstExecuted.run.id} job "${firstExecuted.job.name}" ran on runner ` +
        `${firstExecuted.job.runner_id} and started ${firstExecuted.job.steps.length} step(s)`,
      evidence: { ...evidence, firstExecutedRunId: firstExecuted.run.id }
    }
  }

  // Everything below here is an ABSENCE, and an absence is only a verdict under an observation that
  // could have shown the opposite. Each branch says which one it had.
  if (readable.length === 0) {
    return unknown(
      `${unreadable.length} run(s) after the boundary could not be read, so none of them was observed`,
      evidence
    )
  }
  if (counts.starved > 0) {
    // Deliberately not BILLING_EXHAUSTED. Nothing here has read an account.
    return {
      verdict: CAPACITY.NOT_RESTORED,
      reason:
        `${counts.starved} job(s) after the boundary requested a runner and were assigned none ` +
        `(runner_id 0, no steps started); 0 reached a machine`,
      evidence
    }
  }
  if (counts.unknown > 0) {
    return unknown(
      `${counts.unknown} job(s) have a shape this classifier does not recognise; ` +
        'nothing after the boundary either ran or was provably starved',
      evidence
    )
  }
  if (counts.skipped > 0) {
    // The trap this branch exists for: a skipped job asked for no machine, so it is evidence about
    // a workflow condition and evidence about capacity NOT AT ALL. Reading it as starvation would
    // manufacture a NOT_RESTORED out of a repository that was simply quiet.
    return unknown(
      `every job after the boundary was condition-skipped (${counts.skipped}); ` +
        'a skipped job never requests a runner, so this says nothing about capacity',
      evidence
    )
  }
  return unknown('runs exist after the boundary but reported no jobs at all', evidence)
}

function unknown(reason, evidence) {
  return { verdict: CAPACITY.UNKNOWN, reason, evidence }
}

/** Every verdict is printed with its subject. An unattributed CI answer is not an answer. */
export function formatVerdict(scope, boundary, result) {
  const { examined, unreadable, counts } = result.evidence
  const tally = counts
    ? ` — ${counts.executed} executed, ${counts.starved} starved, ${counts.skipped} skipped, ` +
      `${counts.unknown} unknown`
    : ''
  return [
    `${describeScope(scope)}`,
    `boundary ${boundary}`,
    `examined ${examined} run(s)${unreadable ? `, ${unreadable} unreadable` : ''}${tally}`,
    `CAPACITY ${result.verdict}: ${result.reason}`
  ].join('\n')
}

function gh(endpoint) {
  return JSON.parse(execFileSync('gh', ['api', endpoint], { encoding: 'utf8', maxBuffer: 32e6 }))
}

function fetchRuns(repo, perPage) {
  const page = gh(`repos/${repo}/actions/runs?per_page=${perPage}`)
  return (page.workflow_runs ?? []).map((run) => {
    let jobs = null
    try {
      jobs = gh(`repos/${repo}/actions/runs/${run.id}/jobs`).jobs ?? null
    } catch {
      jobs = null // unreadable, NOT empty -- classifyCapacity keeps the two apart
    }
    return { id: run.id, name: run.name, createdAt: run.created_at, jobs }
  })
}

function main(argv) {
  let scope
  try {
    // No ambient default, and no second parser: the canonical owner resolves the subject or refuses.
    scope = resolveRepoScope({ argv, readOriginUrl: () => readOriginUrlFromGit() })
  } catch (error) {
    console.error(String(error.message ?? error))
    return 2
  }

  const boundary = argv.find((a) => a.startsWith('--since='))?.slice('--since='.length)
    ?? STARVATION_BOUNDARY
  const perPage = Number(argv.find((a) => a.startsWith('--runs='))?.slice('--runs='.length) ?? 20)

  let runs
  try {
    runs = fetchRuns(scope.repo, Math.min(Math.max(perPage, 1), 100))
  } catch (error) {
    // The API being unavailable is a fact about the API. It is not a fact about capacity.
    console.log(formatVerdict(scope, boundary, unknown(`the GitHub API could not be read: ${
      String(error.message ?? error).split('\n')[0]
    }`, { examined: 0 })))
    return 0
  }

  console.log(formatVerdict(scope, boundary, classifyCapacity({ runs, boundary })))
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)))
}
