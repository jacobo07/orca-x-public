import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

/**
 * A runtime refreshes its PTY inventory under one generation counter, so a fresh
 * terminal.list overlapped by another is failed closed. Every client that asks for one
 * must therefore go through src/renderer/src/runtime/runtime-host-query-queue.ts.
 *
 * This gate is a text scan and says so: it proves a queued caller imports the owner, not
 * that the import is on the path the listing actually takes. What it does buy is that a
 * NEW unqueued caller cannot appear without a reviewer seeing this file in the diff.
 */

const SCAN_ROOT = 'src'
const QUEUE_MODULE = 'runtime-host-query-queue'
const BASELINE_PATH = path.join('config', 'runtime-host-query-unqueued-baseline.txt')

// Why: this is the host's own implementation of the parameter, not a caller of it. It is
// excluded structurally rather than baselined, because it can never be "fixed".
const HOST_IMPLEMENTATION_PREFIX = 'src/main/runtime/'

// Why: a sweep that silently stops matching reads exactly like a clean estate.
const MINIMUM_CALLERS = 3

function toPosix(value) {
  return value.split(path.sep).join('/')
}

/** A caller asks for fresh liveness when it sets the flag on a request it sends. */
export function requestsFreshLiveness(source) {
  return /requireFreshPtyLiveness\s*:\s*true/.test(source)
}

export function importsHostQueue(source) {
  return new RegExp(`from\\s+['"][^'"]*${QUEUE_MODULE}['"]`).test(source)
}

async function collectSourceFiles(dir, found = []) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') {
        await collectSourceFiles(full, found)
      }
      continue
    }
    if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      found.push(full)
    }
  }
  return found
}

async function readBaseline() {
  try {
    const text = await fs.readFile(BASELINE_PATH, 'utf8')
    return new Set(
      text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
    )
  } catch {
    return new Set()
  }
}

/**
 * Positive control. A detector that stopped detecting returns the same clean green as one
 * that works, and a drill pinned to a real offender dies the day that offender is fixed —
 * so the red branch is driven against a subject that cannot be fixed out from under it.
 */
function selfCheck() {
  const unqueued = `const x = { requireFreshPtyLiveness: true }`
  const queued = `import { runOnRuntimeHost } from './runtime-host-query-queue'\n${unqueued}`
  const unrelated = `const x = { includeVisualLayouts: false }`
  const failures = []
  if (!requestsFreshLiveness(unqueued)) {
    failures.push('detector did not flag a synthetic unqueued caller')
  }
  if (requestsFreshLiveness(unrelated)) {
    failures.push('detector flagged a file that asks for nothing fresh')
  }
  if (importsHostQueue(unqueued)) {
    failures.push('import check passed a file with no import')
  }
  if (!importsHostQueue(queued)) {
    failures.push('import check failed a file that imports the owner')
  }
  return failures
}

async function main() {
  const controlFailures = selfCheck()
  if (controlFailures.length > 0) {
    console.error('runtime-host-query-queue gate: its own controls failed, so it proves nothing')
    for (const failure of controlFailures) {
      console.error(`  - ${failure}`)
    }
    process.exitCode = 1
    return
  }

  const baseline = await readBaseline()
  const files = await collectSourceFiles(SCAN_ROOT)
  const callers = []
  const unqueued = []

  for (const file of files) {
    const relative = toPosix(path.relative(process.cwd(), file))
    if (relative.startsWith(HOST_IMPLEMENTATION_PREFIX)) {
      continue
    }
    const source = await fs.readFile(file, 'utf8')
    if (!requestsFreshLiveness(source)) {
      continue
    }
    callers.push(relative)
    if (!importsHostQueue(source)) {
      unqueued.push(relative)
    }
  }

  if (callers.length < MINIMUM_CALLERS) {
    console.error(
      `runtime-host-query-queue gate: found ${callers.length} fresh-liveness callers, expected at least ${MINIMUM_CALLERS}.`
    )
    console.error('The sweep probably stopped matching. Fix the gate before trusting a green.')
    process.exitCode = 1
    return
  }

  const newDebt = unqueued.filter((file) => !baseline.has(file))
  // Why: a baseline that outlives its debts becomes a permanent excuse.
  const stale = [...baseline].filter((file) => !unqueued.includes(file))

  if (newDebt.length > 0) {
    console.error('A fresh terminal.list must go through the host query queue. Unqueued callers:')
    for (const file of newDebt) {
      console.error(`  - ${file}`)
    }
    console.error(
      `\nRoute it through runOnRuntimeHost (${QUEUE_MODULE}). Do not add it to ${BASELINE_PATH} to get green.`
    )
    process.exitCode = 1
    return
  }

  if (stale.length > 0) {
    console.error(`${BASELINE_PATH} names callers that are no longer unqueued. Remove them:`)
    for (const file of stale) {
      console.error(`  - ${file}`)
    }
    process.exitCode = 1
    return
  }

  console.log(
    `runtime-host-query-queue: ${callers.length} fresh-liveness callers, ${unqueued.length} unqueued (baseline ${baseline.size}).`
  )
}

await main()
