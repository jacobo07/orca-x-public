import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  OUTCOME,
  defaultRecordPath,
  inspectLiveMutant,
  isClean,
  sha256,
  withMutation
} from './mutation-transaction.mjs'

// Kept as a file:// URL, never as a path. An ESM import of `C:\...` fails with
// ERR_UNSUPPORTED_ESM_URL_SCHEME before a single line of the driver below runs.
const MODULE_URL = new URL('./mutation-transaction.mjs', import.meta.url).href
const SOURCE = 'const answer = ORIGINAL\nconst other = 1\n'

// Every subject here is created, owned and deleted by the test. Nothing points at a real file:
// this is the one class of test where a mistake is not recoverable by reverting a commit.
let dir
let file
let recordPath

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'orca-mutation-'))
  file = path.join(dir, 'subject.mjs')
  recordPath = path.join(dir, 'record.json')
  writeFileSync(file, SOURCE, 'utf8')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const read = () => readFileSync(file, 'utf8')
const plant = { find: 'ORIGINAL', replace: 'MUTANT' }

describe('plant, verify and restore is one transaction', () => {
  it('classifies a caught mutation, and puts the source back', async () => {
    const result = await withMutation({ file, ...plant, recordPath }, async () => ({ passed: false }))
    expect(result.outcome).toBe(OUTCOME.APPLIED_CAUGHT)
    expect(read()).toBe(SOURCE)
    expect(existsSync(recordPath)).toBe(false)
  })

  it('proves the mutation was really in the tree while the verifier ran', async () => {
    let seen = null
    await withMutation({ file, ...plant, recordPath }, async () => {
      seen = read()
      return { passed: false }
    })
    // Without this, a write that silently did nothing produces a green verifier that is
    // indistinguishable from a survived mutant.
    expect(seen).toContain('MUTANT')
    expect(read()).toBe(SOURCE)
  })

  it('keeps a survived mutant apart from a caught one, and neither is a restore failure', async () => {
    const result = await withMutation({ file, ...plant, recordPath }, async () => ({ passed: true }))
    expect(result.outcome).toBe(OUTCOME.APPLIED_SURVIVED)
    expect(isClean(result.outcome)).toBe(false)
    expect(read()).toBe(SOURCE)
  })

  // "The tests did not notice" and "the tests did not run" are opposite facts, and only the first
  // is a coverage gap. Collapsing them invents findings and hides real ones.
  it('a verifier that throws is HARNESS_FAILED, never a survived mutant -- and still restores', async () => {
    const result = await withMutation({ file, ...plant, recordPath }, async () => {
      throw new Error('vitest could not start')
    })
    expect(result.outcome).toBe(OUTCOME.HARNESS_FAILED)
    expect(result.detail).toMatch(/vitest could not start/)
    expect(read()).toBe(SOURCE)
    expect(existsSync(recordPath)).toBe(false)
  })

  it('a verifier with no verdict is HARNESS_FAILED, not a pass', async () => {
    const result = await withMutation({ file, ...plant, recordPath }, async () => undefined)
    expect(result.outcome).toBe(OUTCOME.HARNESS_FAILED)
    expect(read()).toBe(SOURCE)
  })

  it('writes nothing when the anchor is missing, and says so', async () => {
    const result = await withMutation({ file, find: 'ABSENT', replace: 'X', recordPath }, async () => ({
      passed: false
    }))
    expect(result.outcome).toBe(OUTCOME.NOT_APPLIED)
    expect(read()).toBe(SOURCE)
    expect(existsSync(recordPath)).toBe(false)
  })

  // A reverse-replace that lands on the first of several matches restores the wrong occurrence and
  // leaves a mutant that looks restored. Refuse the ambiguous anchor instead.
  it('refuses an anchor that appears more than once', async () => {
    writeFileSync(file, 'ORIGINAL\nORIGINAL\n', 'utf8')
    const result = await withMutation({ file, ...plant, recordPath }, async () => ({ passed: false }))
    expect(result.outcome).toBe(OUTCOME.NOT_APPLIED)
    expect(result.output.join('\n')).toMatch(/more than once/)
    expect(read()).toBe('ORIGINAL\nORIGINAL\n')
  })

  /**
   * A disk that accepts the mutation and then refuses to give the original back.
   *
   * The first read MUST return the real source, or the anchor is missing and the transaction exits
   * at NOT_APPLIED without ever reaching the branch under test -- which is how the first version of
   * these two cases passed while asserting nothing about restore.
   */
  const refusesToRestore = (onClear) => {
    let reads = 0
    return {
      read: () => (++reads === 1 ? SOURCE : SOURCE.replace('ORIGINAL', 'MUTANT')),
      write: () => {},
      readRecord: () => null,
      writeRecord: () => {},
      clearRecord: onClear ?? (() => {})
    }
  }

  it('reports RESTORE_FAILED loudly when the source does not come back', async () => {
    const io = refusesToRestore(() => {
      throw new Error('clearRecord must not run when restore did not verify')
    })
    const result = await withMutation({ file: 'virtual', ...plant, recordPath, io }, async () => ({
      passed: false
    }))
    expect(result.outcome).toBe(OUTCOME.RESTORE_FAILED)
    expect(isClean(result.outcome)).toBe(false)
    expect(result.output.join('\n')).toMatch(/THE SOURCE IS STILL MUTATED/)
  })

  it('RESTORE_FAILED outranks the verifier verdict', async () => {
    // The verifier went red -- normally APPLIED_CAUGHT -- but the tree is still wrong, so the
    // transaction may not be reported as a clean catch.
    const result = await withMutation(
      { file: 'virtual', ...plant, recordPath, io: refusesToRestore() },
      async () => ({ passed: false })
    )
    expect(result.outcome).toBe(OUTCOME.RESTORE_FAILED)
    expect(isClean(result.outcome)).toBe(false)
  })
})

describe('a live mutant is found by evidence, not by searching for strings', () => {
  const record = (extra) =>
    JSON.stringify({ file, originalSha: sha256(SOURCE), mutatedSha: sha256('MUTATED'), ...extra })

  it('reports no transaction when there is no record', () => {
    expect(inspectLiveMutant({ recordPath }).live).toBe(false)
  })

  it('finds a mutant that a dead transaction left behind', () => {
    writeFileSync(file, 'MUTATED', 'utf8')
    writeFileSync(recordPath, record(), 'utf8')
    const found = inspectLiveMutant({ recordPath })
    expect(found.live).toBe(true)
    expect(found.reason).toMatch(/still holds the planted mutation/)
  })

  it('does not accuse a tree whose source is the original', () => {
    writeFileSync(recordPath, record(), 'utf8')
    expect(inspectLiveMutant({ recordPath }).live).toBe(false)
  })

  // Neither hash: somebody edited the file while the transaction was open, so the original is gone
  // and no restore can be trusted. That is not "clean" by any reading.
  it('treats a file edited mid-transaction as live', () => {
    writeFileSync(file, 'SOMETHING ELSE', 'utf8')
    writeFileSync(recordPath, record(), 'utf8')
    expect(inspectLiveMutant({ recordPath }).live).toBe(true)
  })

  it('treats an unreadable record as live rather than as permission', () => {
    writeFileSync(recordPath, '{ not json', 'utf8')
    expect(inspectLiveMutant({ recordPath }).live).toBe(true)
  })

  it('defaults its record to the working directory', () => {
    expect(defaultRecordPath('/repo')).toBe(path.join('/repo', '.mutation-transaction-active.json'))
  })
})

// THE CLAIM: output consumption cannot cancel cleanup ownership.
//
// The source incident, reproduced: a driver's stdout was piped to a consumer that stopped reading
// after N lines (`| Select-Object -First 24`). The closed pipe killed node mid-loop and a planted
// mutation stayed live in the working tree.
describe('a consumer that stops reading cannot leave a mutant behind', () => {
  it('restores the source after its output consumer closes the pipe mid-verify', async () => {
    const driverDir = path.join(dir, 'driver')
    mkdirSync(driverDir)
    const driver = path.join(driverDir, 'drive.mjs')
    // The mutation being LIVE on disk is this drill's precondition, and a driver that died at
    // import restores nothing while leaving a file that reads exactly like a restored one. The
    // sentinel holds what the verifier actually saw, so "never ran" cannot pass as "cleaned up".
    const sentinel = path.join(dir, 'verifier-saw.txt')
    writeFileSync(
      driver,
      [
        `import { withMutation, detachFromOutputConsumer } from ${JSON.stringify(MODULE_URL)}`,
        "import { readFileSync, writeFileSync } from 'node:fs'",
        'detachFromOutputConsumer()',
        `const file = ${JSON.stringify(file)}`,
        `const recordPath = ${JSON.stringify(recordPath)}`,
        "const res = await withMutation({ file, find: 'ORIGINAL', replace: 'MUTANT', recordPath }, async () => {",
        `  writeFileSync(${JSON.stringify(sentinel)}, readFileSync(file, 'utf8'), 'utf8')`,
        // A naive driver reports progress WHILE the source is mutated. This is the write that dies.
        "  for (let i = 0; i < 50000; i++) process.stdout.write('progress ' + i + '\\n')",
        '  return { passed: false }',
        '})',
        "process.stdout.write(res.outcome + '\\n')"
      ].join('\n'),
      'utf8'
    )

    const exitCode = await new Promise((resolve) => {
      const child = spawn(process.execPath, [driver], { stdio: ['ignore', 'pipe', 'inherit'] })
      // Stop reading, exactly as a `head` / `Select-Object -First` consumer does.
      child.stdout.once('data', () => child.stdout.destroy())
      child.on('close', resolve)
    })

    // PRECONDITION FIRST. Without it the three assertions below are satisfied by a driver that
    // never mutated anything, which is how the first version of this drill went green.
    expect(existsSync(sentinel)).toBe(true)
    expect(readFileSync(sentinel, 'utf8')).toContain('MUTANT')

    // The report is expendable; the tree is not. Whatever the consumer did, the source is back and
    // the transaction record is cleared.
    expect(read()).toBe(SOURCE)
    expect(existsSync(recordPath)).toBe(false)
    expect(inspectLiveMutant({ recordPath }).live).toBe(false)
    expect(exitCode).toBe(0)
  }, 30_000)
})
