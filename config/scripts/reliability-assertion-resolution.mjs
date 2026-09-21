import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Resolving a gate's assertionRefs against the source it names.
 *
 * The manifest disciplines claims, but its claim-to-evidence link was never checked: `testFiles`
 * are stat'd, and the assertion strings beside them were compared to nothing at all. Measured
 * 2026-09-13 across 92 gates and 1598 assertions, that field turned out to hold two conventions —
 * verbatim test titles, which name a test a machine can find, and faithful paraphrases of what a
 * test asserts, which no machine can tell apart from a pointer that rotted.
 *
 * Neither is dishonest. Only one is evidence. So this module answers one narrow question — does
 * this string name something that exists — and leaves the policy to the caller.
 */

/**
 * Matching is a plain substring test against the file as written.
 *
 * An earlier version normalized whole files first -- splicing formatter-wrapped literal
 * concatenations and collapsing whitespace -- on the theory that a wrapped title would otherwise be
 * unfindable. Measured over all 570 cited files it rescued exactly zero assertions (1420 unresolved
 * either way, same 12/12/55 split) and cost 8-45s of the gate's runtime, so it bought nothing and
 * paid for it in the one budget a lint gate has. Known limitation, stated rather than papered over:
 * a title broken across source lines will not resolve, and the fix is to keep the title on one line.
 */
function matchable(assertion) {
  return assertion.trim()
}

export const ASSERTION_BASELINE_PATH = path.join('config', 'reliability-assertion-baseline.txt')

/**
 * `<gate-id> <unresolved-count>` per line, `#` comments ignored.
 *
 * A malformed line throws rather than being skipped: a baseline that silently drops an entry it
 * could not read grants that gate an exemption nobody wrote, which is the failure this file exists
 * to prevent.
 */
export function parseAssertionBaseline(text) {
  const entries = new Map()
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue
    }
    const match = /^(\S+)\s+(\d+)$/.exec(trimmed)
    if (!match) {
      throw new Error(
        `${ASSERTION_BASELINE_PATH}:${index + 1}: expected "<gate-id> <count>", got "${trimmed}"`
      )
    }
    entries.set(match[1], Number(match[2]))
  }
  return entries
}

/** The leading comment block, so pruning cannot silently drop the rules written above the entries. */
export function extractBaselineHeader(text) {
  const header = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('#') && line.trim().length > 0) {
      break
    }
    header.push(line)
  }
  return `${header.join('\n').replace(/\n+$/, '')}\n`
}

/**
 * Rewrites the baseline from measured reality, in the shrinking direction only.
 *
 * Growth is REFUSED rather than recorded: a prune that could add an entry would turn the one
 * command a developer reaches for when the gate is red into the way to make new debt permanent,
 * which is the whole failure mode the ratchet exists to prevent.
 */
export function pruneBaseline(recorded, measured) {
  const kept = []
  const refused = []
  for (const [gateId, unresolved] of measured) {
    const previous = recorded.get(gateId)
    if (previous === undefined) {
      refused.push(`${gateId}: ${unresolved} unresolved assertion(s) and no baseline entry`)
    } else if (unresolved > previous) {
      refused.push(`${gateId}: unresolved assertions grew ${previous} -> ${unresolved}`)
    } else {
      kept.push(`${gateId} ${unresolved}`)
    }
  }
  kept.sort()
  return { kept, refused }
}

/**
 * Cache keyed on the resolved path: a gate cites the same file from several refs, and 570 files
 * across the manifest is enough re-reading to notice.
 */
export function createAssertionSourceReader(root) {
  const cache = new Map()
  async function load(filePath) {
    try {
      cache.set(filePath, await fs.readFile(path.join(root, filePath), 'utf8'))
    } catch {
      cache.set(filePath, null)
    }
  }
  async function readSource(filePath) {
    if (!cache.has(filePath)) {
      await load(filePath)
    }
    return cache.get(filePath)
  }
  /**
   * Warm the cache in bounded parallel. The gate is latency-bound, not CPU-bound -- 570 files read
   * one await at a time measured 2-12s depending on what else the machine was doing, which would
   * have made every downstream verdict a function of host load. Bounded rather than Promise.all:
   * these are source files and an unbounded fan-out is a memory budget, not a speedup.
   */
  readSource.prefetch = async function prefetch(filePaths, concurrency = 16) {
    const pending = [...new Set(filePaths)].filter((filePath) => !cache.has(filePath))
    let next = 0
    await Promise.all(
      Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
        while (next < pending.length) {
          await load(pending[next++])
        }
      })
    )
  }
  return readSource
}

/**
 * Counts assertions that do NOT appear in the file their ref names.
 *
 * `unreadable` is kept apart from `unresolved` deliberately: a file we could not open tells us
 * nothing about whether its assertions exist, and folding that into the unresolved count would
 * promote a failure to read into a finding about the gate. testFiles existence is checked
 * separately by the caller, which is where an absent file should be reported.
 */
export async function resolveGateAssertions(gate, readSource) {
  let total = 0
  let unresolved = 0
  let unreadable = 0
  const missing = []
  for (const ref of Array.isArray(gate.assertionRefs) ? gate.assertionRefs : []) {
    if (!ref || typeof ref.file !== 'string' || !Array.isArray(ref.assertions)) {
      continue
    }
    const source = await readSource(ref.file)
    if (source === null) {
      unreadable += ref.assertions.length
      continue
    }
    for (const assertion of ref.assertions) {
      if (typeof assertion !== 'string') {
        continue
      }
      total += 1
      if (!source.includes(matchable(assertion))) {
        unresolved += 1
        missing.push({ file: ref.file, assertion })
      }
    }
  }
  return { total, unresolved, unreadable, missing }
}
