import { createHash } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'

// Planting a mutation, running a verifier against it and putting the source back is ONE
// transaction. It is routinely written as three steps in a script, and the third step is the one
// that does not run.
//
// MEASURED, this estate: a driver's stdout was piped into a consumer that stopped reading after N
// lines. The consumer's exit closed the pipe, node took EPIPE on its next write and died mid-loop,
// and a planted mutation stayed live in the working tree. A later test caught it, which is luck
// rather than design -- the tree had been silently wrong in between, and every verdict taken from
// it was about a file nobody meant to be reading.
//
// The defect is not the pipe. It is that THE CONSUMER OF THE OUTPUT OWNED THE LIFETIME OF THE
// TRANSACTION. Whoever reads the report must not be able to cancel the cleanup, and this module
// exists so that is structural rather than remembered:
//
//   1. nothing is written to stdout WHILE the source is mutated -- output is accumulated and
//      handed back after restore, so a dead consumer is not even reachable until the tree is clean;
//   2. restore runs in `finally`, so a verifier that throws, rejects or is killed still restores;
//   3. restore is VERIFIED by hash, and a restore that did not verify is its own outcome that
//      cannot be read as success;
//   4. an on-disk record is written BEFORE the mutation and cleared only after a verified restore,
//      so a process that dies between them leaves durable evidence instead of a silent mutant.

export const OUTCOME = {
  /** The anchor was not found. Nothing was written, so the tree is untouched. */
  NOT_APPLIED: 'NOT_APPLIED',
  /** Applied, and the verifier went red. The regression would be noticed. */
  APPLIED_CAUGHT: 'APPLIED_CAUGHT',
  /** Applied, and the verifier stayed green. A coverage gap, or an equivalent mutant. */
  APPLIED_SURVIVED: 'APPLIED_SURVIVED',
  /** The verifier could not run. This says nothing whatever about the subject. */
  HARNESS_FAILED: 'HARNESS_FAILED',
  /** The source is NOT back. Outranks every other outcome, because the tree is still wrong. */
  RESTORE_FAILED: 'RESTORE_FAILED'
}

/** Outcomes that may be reported as a clean result. `RESTORE_FAILED` is deliberately absent. */
export function isClean(outcome) {
  return outcome === OUTCOME.APPLIED_CAUGHT || outcome === OUTCOME.NOT_APPLIED
}

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

const defaultIo = {
  read: (file) => readFileSync(file, 'utf8'),
  write: (file, text) => writeFileSync(file, text, 'utf8'),
  readRecord: (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null),
  writeRecord: (p, text) => writeFileSync(p, text, 'utf8'),
  clearRecord: (p) => rmSync(p, { force: true })
}

export function defaultRecordPath(cwd = process.cwd()) {
  return path.join(cwd, '.mutation-transaction-active.json')
}

/**
 * Is a mutation from a previous, dead transaction still in the tree?
 *
 * Evidence, not a string search: the record names the file and the two hashes, so this reports the
 * difference between "the mutation is still live", "the file moved on to something else" and
 * "restored but the record outlived it" rather than guessing from content.
 */
export function inspectLiveMutant({ recordPath = defaultRecordPath(), io = defaultIo } = {}) {
  const raw = io.readRecord(recordPath)
  if (raw === null) {
    return { live: false, reason: 'no transaction record' }
  }
  let record
  try {
    record = JSON.parse(raw)
  } catch {
    // A record we cannot read is not permission to assume the tree is clean.
    return { live: true, reason: `transaction record at ${recordPath} is unreadable`, record: null }
  }
  let current
  try {
    current = sha256(io.read(record.file))
  } catch (error) {
    return { live: true, reason: `cannot read ${record.file}: ${error.message}`, record }
  }
  if (current === record.mutatedSha) {
    return { live: true, reason: `${record.file} still holds the planted mutation`, record }
  }
  if (current === record.originalSha) {
    return { live: false, reason: 'source is original; the record outlived a completed restore', record }
  }
  return {
    live: true,
    reason: `${record.file} matches neither the original nor the mutant; it was edited mid-transaction`,
    record
  }
}

/**
 * Run one mutation as a transaction.
 *
 * `verify` receives nothing and returns `{ passed: boolean }` -- `passed: false` means the verifier
 * went RED, which is the mutation being CAUGHT. A verifier that throws means it could not run, and
 * that is HARNESS_FAILED, never a survived mutant: "the tests did not notice" and "the tests did
 * not run" are opposite facts and the second one is about the harness.
 *
 * Anything this function wants to say is returned in `output`. It writes nothing anywhere a reader
 * could be listening while the source is mutated.
 */
export async function withMutation(
  { file, find, replace, recordPath = defaultRecordPath(), io = defaultIo },
  verify
) {
  const output = []
  const say = (line) => output.push(line)

  const original = io.read(file)
  const originalSha = sha256(original)

  if (!original.includes(find)) {
    say(`NOT_APPLIED ${file}: anchor not found, nothing written`)
    return { outcome: OUTCOME.NOT_APPLIED, originalSha, output }
  }
  // A unique anchor or nothing. A reverse-replace that lands on the first of several matches
  // restores the wrong occurrence and leaves a mutant that looks restored.
  if (original.indexOf(find) !== original.lastIndexOf(find)) {
    say(`NOT_APPLIED ${file}: anchor appears more than once, so restore could not be exact`)
    return { outcome: OUTCOME.NOT_APPLIED, originalSha, output }
  }

  const mutated = original.replace(find, replace)
  const mutatedSha = sha256(mutated)

  // Written BEFORE the first byte of the mutation. If this process dies at any point below, the
  // record is what tells the next one that the tree is not clean.
  io.writeRecord(
    recordPath,
    JSON.stringify({ file, originalSha, mutatedSha, startedAt: new Date().toISOString() }, null, 2)
  )

  let outcome = OUTCOME.HARNESS_FAILED
  let detail = null
  try {
    io.write(file, mutated)
    // Proving the mutation is really in the tree. Without this a write that silently did nothing
    // produces a green verifier that reads exactly like a survived mutant.
    if (sha256(io.read(file)) !== mutatedSha) {
      say(`HARNESS_FAILED ${file}: the mutation did not land on disk`)
      detail = 'mutation did not land'
    } else {
      let result
      try {
        result = await verify()
      } catch (error) {
        detail = `verifier threw: ${error?.message ?? error}`
        result = null
      }
      if (result && typeof result.passed === 'boolean') {
        outcome = result.passed ? OUTCOME.APPLIED_SURVIVED : OUTCOME.APPLIED_CAUGHT
        detail = result.detail ?? null
      } else if (detail === null) {
        detail = 'verifier returned no { passed } verdict'
      }
    }
  } finally {
    // UNCONDITIONAL. This is the whole point of the module: it runs when the verifier throws, when
    // it hangs into a rejection, and when the caller above stops caring about the answer.
    try {
      io.write(file, original)
      const restoredSha = sha256(io.read(file))
      if (restoredSha !== originalSha) {
        outcome = OUTCOME.RESTORE_FAILED
        detail = `restored bytes hash ${restoredSha.slice(0, 12)}, expected ${originalSha.slice(0, 12)}`
      } else {
        io.clearRecord(recordPath)
      }
    } catch (error) {
      outcome = OUTCOME.RESTORE_FAILED
      detail = `restore threw: ${error?.message ?? error}`
    }
  }

  say(`${outcome} ${file}${detail ? ` -- ${detail}` : ''}`)
  if (outcome === OUTCOME.RESTORE_FAILED) {
    say(`  THE SOURCE IS STILL MUTATED. Record kept at ${recordPath}; restore it before trusting any verdict.`)
  }
  return { outcome, detail, originalSha, mutatedSha, output }
}

/**
 * Make this process survive a consumer that stops reading.
 *
 * EPIPE on stdout is what killed the driver in the source incident. Swallowing it means a closed
 * pipe costs the report and never the cleanup.
 */
export function detachFromOutputConsumer(streams = [process.stdout, process.stderr]) {
  for (const stream of streams) {
    stream.on('error', (error) => {
      if (error?.code !== 'EPIPE') throw error
    })
  }
}
