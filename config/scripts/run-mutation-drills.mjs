import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  OUTCOME,
  defaultRecordPath,
  detachFromOutputConsumer,
  inspectLiveMutant,
  withMutation
} from './mutation-transaction.mjs'

// A green suite is evidence about the tests only once something has driven their red branch. This
// plants each mutation, runs the gate that should notice, and restores -- as ONE transaction, so a
// reader who stops reading cannot leave the tree mutated.
//
// Not a gate: it edits source. It is a drill, run deliberately.

detachFromOutputConsumer()

const REPO = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const rel = (p) => path.join(REPO, p)

const CAPACITY = 'config/scripts/report-ci-capacity.mjs'
const SCOPE = 'config/scripts/ci-repo-scope.mjs'
const TRANSACTION = 'config/scripts/mutation-transaction.mjs'

const CAPACITY_TESTS = ['config/scripts/report-ci-capacity.test.mjs']
const SCOPE_TESTS = ['config/scripts/ci-repo-scope.test.mjs']
const TRANSACTION_TESTS = ['config/scripts/mutation-transaction.test.mjs']

/** Each entry names the belief it removes, not the token it edits. */
const DRILLS = [
  {
    id: 'M1-skipped-becomes-starvation',
    claim: 'a condition-skipped job never counts as a job that was denied a runner',
    file: CAPACITY,
    find: 'counts.skipped += 1',
    replace: 'counts.starved += 1',
    tests: CAPACITY_TESTS
  },
  {
    id: 'M2-boundary-ignored',
    claim: 'execution from before the outage does not end the outage',
    file: CAPACITY,
    find: 'return Number.isFinite(created) && created >= cutoff',
    replace: 'return true',
    tests: CAPACITY_TESTS
  },
  {
    id: 'M3-unreadable-is-not-a-hole',
    claim: 'a run whose jobs could not be read is a hole in the evidence, not a starved job',
    file: CAPACITY,
    find: 'if (readable.length === 0) {',
    replace: 'if (false) {',
    tests: CAPACITY_TESTS
  },
  {
    id: 'M4-verdict-loses-its-subject',
    claim: 'every capacity verdict names the repository it is about',
    file: CAPACITY,
    find: '`${describeScope(scope)}`,',
    replace: "'',",
    tests: CAPACITY_TESTS
  },
  {
    id: 'M5-ambient-repo-fallback',
    claim: 'an unresolvable repository scope refuses instead of inheriting the tool default',
    file: SCOPE,
    find: 'if (derived === null) {',
    replace: 'if (false) {',
    tests: SCOPE_TESTS
  },
  {
    id: 'M6-restore-skipped-when-verifier-failed',
    claim: 'restore is unconditional -- a verifier that could not run still gets its source back',
    file: TRANSACTION,
    find: '      io.write(file, original)',
    replace: '      if (outcome !== OUTCOME.HARNESS_FAILED) io.write(file, original)',
    tests: TRANSACTION_TESTS
  },
  {
    id: 'M7-output-consumer-owns-the-process',
    claim: 'a closed output pipe costs the report, never the cleanup',
    file: TRANSACTION,
    find: "      if (error?.code !== 'EPIPE') throw error",
    replace: '      throw error',
    tests: TRANSACTION_TESTS
  }
]

function runVitest(testFiles) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [rel('node_modules/vitest/vitest.mjs'), 'run', '--config', 'config/vitest.config.ts', ...testFiles],
      { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let tail = ''
    const keep = (d) => {
      tail = (tail + d).slice(-400)
    }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    // A spawn that never produced a vitest summary did not run the tests, and "did not run" must
    // never be reported as "did not notice".
    child.on('close', (code) => {
      if (!/Test Files|Tests\s/.test(tail)) {
        resolve({ ran: false, detail: 'vitest produced no summary' })
      } else {
        resolve({ ran: true, passed: code === 0 })
      }
    })
    child.on('error', (e) => resolve({ ran: false, detail: e.message }))
  })
}

async function main() {
  const record = defaultRecordPath(REPO)
  const preflight = inspectLiveMutant({ recordPath: record })
  if (preflight.live) {
    console.error(`REFUSING TO START: ${preflight.reason}`)
    return 2
  }

  const results = []
  for (const drill of DRILLS) {
    const outcome = await withMutation(
      { file: rel(drill.file), find: drill.find, replace: drill.replace, recordPath: record },
      async () => {
        const run = await runVitest(drill.tests)
        if (!run.ran) throw new Error(run.detail)
        return { passed: run.passed }
      }
    )
    results.push({ drill, ...outcome })
    // Printed only after the transaction closed, so a dead reader cannot interrupt a restore.
    console.log(`${outcome.outcome.padEnd(17)} ${drill.id}`)
    console.log(`                  ${drill.claim}`)
  }

  const survived = results.filter((r) => r.outcome === OUTCOME.APPLIED_SURVIVED)
  const broken = results.filter(
    (r) => r.outcome === OUTCOME.RESTORE_FAILED || r.outcome === OUTCOME.HARNESS_FAILED || r.outcome === OUTCOME.NOT_APPLIED
  )
  const caught = results.filter((r) => r.outcome === OUTCOME.APPLIED_CAUGHT)

  console.log(
    `\nMUTATION_DRILLS caught=${caught.length} survived=${survived.length} ` +
      `unusable=${broken.length} of ${DRILLS.length}`
  )
  for (const r of broken) console.log(`  UNUSABLE ${r.drill.id}: ${r.outcome} ${r.detail ?? ''}`)
  for (const r of survived) console.log(`  SURVIVED ${r.drill.id}: ${r.drill.claim}`)

  const after = inspectLiveMutant({ recordPath: record })
  console.log(after.live ? `TREE NOT CLEAN: ${after.reason}` : 'TREE CLEAN: no live mutant')
  return after.live || broken.length > 0 ? 1 : 0
}

process.exit(await main())
