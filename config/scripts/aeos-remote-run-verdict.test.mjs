import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  classifyRemoteRun,
  exitCodeFor,
  readRemoteRun,
  REMOTE_RUN_VERDICT
} from './aeos-remote-run-verdict.mjs'

const manifest = { schema: 'aeos-remote-run/1', sha: '21dce77a5475f050e7fc77b8867ffce273510f34', host: 'kobicraft-gex44' }
const report = (total, failed) => ({ numTotalTests: total, numPassedTests: total - failed, numFailedTests: failed })
const endWith = (memAvailableMb) => ({ after: { memAvailableMb }, signal: '' })

const dirs = []
const makeRunDir = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'aeos-run-'))
  dirs.push(dir)
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  return dir
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true })
})

describe('a run that cannot state its verdict', () => {
  it('reads a missing exit code as terminated, never as a failing suite', () => {
    const { verdict, reason } = classifyRemoteRun({ manifest, rc: null, report: report(4000, 0) })

    expect(verdict).toBe(REMOTE_RUN_VERDICT.processTerminated)
    expect(verdict).not.toBe(REMOTE_RUN_VERDICT.fail)
    expect(reason).toMatch(/terminated/)
  })

  it('refuses a result that names no revision or host', () => {
    expect(classifyRemoteRun({ manifest: null, rc: 0, report: report(10, 0) }).verdict).toBe(
      REMOTE_RUN_VERDICT.manifestMissing
    )
    expect(classifyRemoteRun({ manifest: { host: 'gex44' }, rc: 0, report: report(10, 0) }).verdict).toBe(
      REMOTE_RUN_VERDICT.manifestMissing
    )
  })

  it('separates a wall-clock budget from a test result', () => {
    expect(classifyRemoteRun({ manifest, rc: 124, report: null }).verdict).toBe(REMOTE_RUN_VERDICT.budgetExceeded)
  })
})

describe('a run whose instrument failed', () => {
  it('will not read an unreadable report as a pass', () => {
    expect(classifyRemoteRun({ manifest, rc: 0, report: null }).verdict).toBe(REMOTE_RUN_VERDICT.harnessFailed)
  })

  // Without this an include glob that matched nothing reports what a clean suite reports.
  it('will not read zero collected tests as a pass', () => {
    const { verdict, reason } = classifyRemoteRun({ manifest, rc: 0, report: report(0, 0) })

    expect(verdict).toBe(REMOTE_RUN_VERDICT.harnessFailed)
    expect(reason).toMatch(/zero tests/)
  })

  it('trusts neither instrument when the exit code and the report disagree', () => {
    expect(classifyRemoteRun({ manifest, rc: 1, report: report(10, 0) }).verdict).toBe(REMOTE_RUN_VERDICT.harnessFailed)
    expect(classifyRemoteRun({ manifest, rc: 0, report: report(10, 3) }).verdict).toBe(REMOTE_RUN_VERDICT.harnessFailed)
  })
})

describe('host starvation gates a failure, never a pass', () => {
  it('refuses to attribute a failure to the code on a starved host', () => {
    const { verdict, reason } = classifyRemoteRun({ manifest, rc: 1, report: report(10, 3), end: endWith(512) })

    expect(verdict).toBe(REMOTE_RUN_VERDICT.inconclusive)
    expect(reason).toMatch(/512 MB/)
  })

  it('reports the same failure as FAIL on a healthy host', () => {
    expect(classifyRemoteRun({ manifest, rc: 1, report: report(10, 3), end: endWith(59_000) }).verdict).toBe(
      REMOTE_RUN_VERDICT.fail
    )
  })

  // Starvation can turn a pass into a failure; it cannot invent a pass.
  it('still reports a pass on a starved host', () => {
    expect(classifyRemoteRun({ manifest, rc: 0, report: report(10, 0), end: endWith(512) }).verdict).toBe(
      REMOTE_RUN_VERDICT.pass
    )
  })
})

describe('the log is not a verdict', () => {
  it('passes a run whose log is full of the word FAIL', () => {
    const noisyLog = ['FAIL', 'stderr | a test named FAIL fast', 'FAIL', 'FAIL'].join('\n')
    const dir = makeRunDir({
      'run.json': JSON.stringify(manifest),
      'run-end.json': JSON.stringify(endWith(59_000)),
      'vitest.json': JSON.stringify(report(4213, 0)),
      'vitest.log': noisyLog,
      rc: '0\n'
    })

    const result = classifyRemoteRun(readRemoteRun(dir))

    expect(result.verdict).toBe(REMOTE_RUN_VERDICT.pass)
    expect(result.evidence.total).toBe(4213)
  })

  it('fails a run whose log contains no failure text at all', () => {
    const dir = makeRunDir({
      'run.json': JSON.stringify(manifest),
      'run-end.json': JSON.stringify(endWith(59_000)),
      'vitest.json': JSON.stringify(report(4213, 7)),
      'vitest.log': '·········· all quiet ··········',
      rc: '1\n'
    })

    expect(classifyRemoteRun(readRemoteRun(dir)).verdict).toBe(REMOTE_RUN_VERDICT.fail)
  })

  it('reads a run directory with only a log as terminated', () => {
    const dir = makeRunDir({ 'run.json': JSON.stringify(manifest), 'vitest.log': 'FAIL FAIL FAIL' })

    expect(classifyRemoteRun(readRemoteRun(dir)).verdict).toBe(REMOTE_RUN_VERDICT.processTerminated)
  })
})

describe('exit codes keep a non-verdict distinct from a failure', () => {
  it('maps pass to 0, fail to 1 and every non-verdict to 2', () => {
    expect(exitCodeFor(REMOTE_RUN_VERDICT.pass)).toBe(0)
    expect(exitCodeFor(REMOTE_RUN_VERDICT.fail)).toBe(1)
    for (const verdict of [
      REMOTE_RUN_VERDICT.manifestMissing,
      REMOTE_RUN_VERDICT.processTerminated,
      REMOTE_RUN_VERDICT.budgetExceeded,
      REMOTE_RUN_VERDICT.harnessFailed,
      REMOTE_RUN_VERDICT.inconclusive
    ]) {
      expect(exitCodeFor(verdict)).toBe(2)
    }
  })
})
