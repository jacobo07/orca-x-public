import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  JOB_STATE,
  RUNG,
  classifyJob,
  classifyRun,
  verdictIsAboutTheCode
} from './report-ci-execution-rungs.mjs'

// Fixtures are REAL records captured from jacobo07/orca-x on 2026-09-21 via
// `gh api repos/jacobo07/orca-x/actions/runs/<id>/jobs`. Run ids are named so the capture can be
// re-taken. Step bodies are synthesized to the measured LENGTH, because the classifier reads only
// the count and the per-step conclusion; every other field below is as the API returned it.
const steps = (count, conclusion = 'success') =>
  Array.from({ length: count }, (_, index) => ({ number: index + 1, conclusion }))

// Run 34726494245 — E2E on main, 2026-09-13 01:51 UTC, 1930s. The LAST run on this repository
// that was ever assigned a runner.
const EXECUTED_RUN_JOBS = [
  {
    name: 'build e2e app',
    conclusion: 'success',
    runner_id: 1000002308,
    runner_name: 'GitHub Actions 1000002308',
    steps: steps(13)
  },
  {
    name: 'e2e 5-of-10',
    conclusion: 'failure',
    runner_id: 1000002309,
    runner_name: 'GitHub Actions 1000002309',
    steps: steps(15, 'failure')
  },
  // Same run, and this one never asked for a machine: the changed-spec filter selected nothing.
  { name: 'changed e2e specs', conclusion: 'skipped', runner_id: null, runner_name: null, steps: [] }
]

// Run 34752613206 — Computer-use e2e, 2026-09-13 12:43 UTC, 9s. The FIRST starved run.
const STARVED_RUN_JOBS = [
  { name: 'mac', conclusion: 'failure', runner_id: 0, runner_name: '', steps: [] },
  { name: 'windows', conclusion: 'failure', runner_id: 0, runner_name: '', steps: [] },
  { name: 'linux', conclusion: 'failure', runner_id: 0, runner_name: '', steps: [] },
  {
    name: 'mac-native-owner-smoke',
    conclusion: 'skipped',
    runner_id: null,
    runner_name: null,
    steps: []
  }
]

describe('a job is classified by whether a machine ran it', () => {
  it('reads runner_id > 0 with steps as executed', () => {
    expect(classifyJob(EXECUTED_RUN_JOBS[0])).toBe(JOB_STATE.EXECUTED)
  })

  // The case this module exists for. conclusion is `failure` and nothing ran.
  it('reads runner_id 0 with no steps as the executor never arriving', () => {
    expect(classifyJob(STARVED_RUN_JOBS[0])).toBe(JOB_STATE.EXECUTOR_UNAVAILABLE)
  })

  it('reads runner_id null with conclusion skipped as a condition, not a failure', () => {
    expect(classifyJob(EXECUTED_RUN_JOBS[2])).toBe(JOB_STATE.CONDITION_SKIPPED)
  })

  it('leaves a shape it has not seen as unknown rather than guessing', () => {
    expect(classifyJob({ runner_id: 0, conclusion: 'failure', steps: steps(3) })).toBe(JOB_STATE.UNKNOWN)
    expect(classifyJob({ runner_id: 5, conclusion: 'failure', steps: [] })).toBe(JOB_STATE.UNKNOWN)
    expect(classifyJob({ runner_id: null, conclusion: 'failure', steps: [] })).toBe(JOB_STATE.UNKNOWN)
    expect(classifyJob(undefined)).toBe(JOB_STATE.UNKNOWN)
  })

  // Duration is a proxy and this repository breaks it: a skipped job reports completed_at before
  // started_at. Timing fields must not reach the verdict.
  it('ignores timing, including a skipped job whose duration is negative', () => {
    const base = { runner_id: null, conclusion: 'skipped', steps: [] }
    expect(classifyJob({ ...base, started_at: '2026-09-13T12:43:10Z', completed_at: '2026-09-13T12:43:09Z' })).toBe(
      JOB_STATE.CONDITION_SKIPPED
    )
    const fast = { runner_id: 42, conclusion: 'success', steps: steps(2) }
    expect(classifyJob({ ...fast, started_at: '2026-09-13T01:51:00Z', completed_at: '2026-09-13T01:51:01Z' })).toBe(
      JOB_STATE.EXECUTED
    )
  })
})

describe('a run reports the highest rung it actually reached', () => {
  it('an executed run reaches a verdict, and its conclusion is about the code', () => {
    const summary = classifyRun(EXECUTED_RUN_JOBS)
    expect(summary.highestRung).toBe(RUNG.VERDICT_OBSERVED)
    expect(summary.blocked).toBeNull()
    expect(summary.counts).toMatchObject({ executed: 2, starved: 0, skipped: 1 })
    expect(verdictIsAboutTheCode(summary)).toBe(true)
  })

  it('a starved run stops at RUN_CREATED and is blocked, not failed', () => {
    const summary = classifyRun(STARVED_RUN_JOBS)
    expect(summary.highestRung).toBe(RUNG.RUN_CREATED)
    expect(summary.blocked).toBe('EXECUTOR_UNAVAILABLE')
    expect(summary.counts).toMatchObject({ executed: 0, starved: 3, skipped: 1 })
    expect(verdictIsAboutTheCode(summary)).toBe(false)
  })

  it('one executed job is enough to make the run a statement about the code', () => {
    const summary = classifyRun([EXECUTED_RUN_JOBS[0], STARVED_RUN_JOBS[0]])
    expect(summary.highestRung).toBe(RUNG.VERDICT_OBSERVED)
    expect(summary.blocked).toBeNull()
  })

  it('separates an all-skipped run from a starved one', () => {
    expect(classifyRun([EXECUTED_RUN_JOBS[2]]).blocked).toBe('ALL_JOBS_CONDITION_SKIPPED')
    expect(classifyRun([]).blocked).toBe('NO_JOBS_REPORTED')
  })

  // Run metadata cannot see an account. Naming a cause here would promote an inference to a
  // measurement, which is the one move this whole module exists to prevent.
  it('never names a billing cause, because it has not looked at billing', () => {
    for (const jobs of [STARVED_RUN_JOBS, EXECUTED_RUN_JOBS, [], [{ runner_id: 0, steps: [] }]]) {
      expect(classifyRun(jobs).blocked ?? '').not.toMatch(/BILLING|QUOTA|MINUTES|SPEND/i)
    }
  })
})

// Operational Reality. Opt-in because it needs network and an authenticated gh; the fixtures above
// are transcriptions, and this is the run that proves they still describe the world.
const live = process.env.ORCA_CI_RUNG_LIVE === '1' ? it : it.skip

describe('against real GitHub history', () => {
  live('classifies the last executed run and the first starved run', () => {
    const jobsOf = (runId) =>
      JSON.parse(
        execFileSync('gh', ['api', `repos/jacobo07/orca-x/actions/runs/${runId}/jobs`], {
          encoding: 'utf8',
          maxBuffer: 32e6
        })
      ).jobs

    const executed = classifyRun(jobsOf('34726494245'))
    expect(executed.highestRung).toBe(RUNG.VERDICT_OBSERVED)
    expect(executed.counts.executed).toBeGreaterThan(0)

    const starved = classifyRun(jobsOf('34752613206'))
    expect(starved.highestRung).toBe(RUNG.RUN_CREATED)
    expect(starved.blocked).toBe('EXECUTOR_UNAVAILABLE')
    expect(starved.counts.executed).toBe(0)
  })
})
