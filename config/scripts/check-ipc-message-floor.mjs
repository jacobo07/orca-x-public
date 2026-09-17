import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

/**
 * Every forked child with an IPC channel must keep a `'message'` listener for its whole life.
 *
 * Node delivers IPC messages a tick after reading them and checks the channel only when it
 * schedules. On that later tick, a child with no `'message'` listener sends node into
 * `ArrayPrototypePush(target.channel[kPendingMessages], ...)` — and `channel` is null once
 * `disconnect()` ran or the child exited. The host then dies on
 * `TypeError: Cannot read properties of null (reading 'Symbol(kPendingMessages)')`, thrown from a
 * tick, so no call site can catch it. Orca hit this twice in the main process on 2026-09-17.
 *
 * `src/shared/ipc-message-listener-floor.ts` holds that listener. This gate exists because the
 * hazard is invisible at the call site: a fork looks harmless, and the teardown that arms it
 * (dropping the last listener, then disconnecting or killing) usually lives in another function.
 */
const SCAN_ROOTS = ['src']
const FLOOR_MODULE = 'src/shared/ipc-message-listener-floor.ts'
const FLOOR_IMPORT = 'ipc-message-listener-floor'
const BASELINE_PATH = path.join('config', 'ipc-message-floor-baseline.txt')
// Why a floor on the population: a sweep that silently stopped matching reports the same clean
// bill as a healthy estate. Orca has seven fork sites; five is the alarm line.
const MIN_SITES = 5

/** True when the file takes `fork` from node's child_process, however it later calls it. */
export function importsNodeFork(source) {
  return /import\s*\{[^}]*\bfork\b[^}]*\}\s*from\s*['"]node:child_process['"]/.test(source)
}

/** True when the file hands `'ipc'` to spawn/execFile through an explicit stdio triple or more. */
export function requestsIpcStdio(source) {
  return /stdio\s*:\s*\[[^\]]*['"]ipc['"]/.test(source)
}

export function ownsIpcChild(source) {
  return importsNodeFork(source) || requestsIpcStdio(source)
}

export function installsFloor(source) {
  return new RegExp(`from\\s+['"][^'"]*${FLOOR_IMPORT}['"]`).test(source)
}

export function parseBaseline(text) {
  return new Set(
    text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
  )
}

function toPosix(value) {
  return value.split(path.sep).join('/')
}

async function collectSourceFiles(root, dir, out) {
  let entries
  try {
    entries = await fs.readdir(path.join(root, dir), { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const relative = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'out') {
        continue
      }
      await collectSourceFiles(root, relative, out)
      continue
    }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) {
      continue
    }
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.spec.ts')) {
      continue
    }
    out.push(toPosix(relative))
  }
  return out
}

/** Positive control: the detector must flag an unguarded fork and clear a floored one. */
export function selfCheck() {
  const unguarded = "import { fork } from 'node:child_process'\nconst child = fork(entry, [], {})\n"
  const guarded =
    "import { forkIpcChild } from '../shared/ipc-message-listener-floor'\nconst child = forkIpcChild(entry, [], {})\n"
  const spawned = "const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })\n"
  const failures = []
  if (!ownsIpcChild(unguarded) || installsFloor(unguarded)) {
    failures.push('detector missed an unguarded fork')
  }
  if (!installsFloor(guarded)) {
    failures.push('detector did not recognise the floor import')
  }
  if (!ownsIpcChild(spawned)) {
    failures.push('detector missed a spawn with an ipc stdio slot')
  }
  return failures
}

async function main() {
  const repoRoot = process.cwd()
  const selfCheckFailures = selfCheck()
  if (selfCheckFailures.length > 0) {
    console.error('IPC message floor gate: the detector itself is broken.')
    for (const failure of selfCheckFailures) {
      console.error(`  - ${failure}`)
    }
    process.exitCode = 1
    return
  }

  let baseline = new Set()
  try {
    baseline = parseBaseline(await fs.readFile(path.join(repoRoot, BASELINE_PATH), 'utf8'))
  } catch {
    // An absent baseline means nothing is grandfathered, which is the target state.
  }

  const files = []
  for (const root of SCAN_ROOTS) {
    await collectSourceFiles(repoRoot, root, files)
  }

  const owners = []
  const unguarded = []
  for (const file of files) {
    if (file === FLOOR_MODULE) {
      continue
    }
    const source = await fs.readFile(path.join(repoRoot, file), 'utf8')
    if (!ownsIpcChild(source)) {
      continue
    }
    owners.push(file)
    if (!installsFloor(source)) {
      unguarded.push(file)
    }
  }

  const failures = []
  if (owners.length < MIN_SITES) {
    failures.push(
      `found only ${owners.length} IPC child owners (expected at least ${MIN_SITES}) — the sweep is probably broken, not the code`
    )
  }

  const newDebt = unguarded.filter((file) => !baseline.has(file))
  for (const file of newDebt) {
    failures.push(
      `${file} owns an IPC child but never installs the message floor — fork through forkIpcChild(), or call installIpcMessageListenerFloor(child)`
    )
  }

  const stale = [...baseline].filter((file) => !unguarded.includes(file))
  for (const file of stale) {
    failures.push(
      `${file} is in ${toPosix(BASELINE_PATH)} but no longer needs to be — delete the line (the list only shrinks)`
    )
  }

  if (failures.length > 0) {
    console.error('IPC message floor check failed:')
    for (const failure of failures) {
      console.error(`  - ${failure}`)
    }
    process.exitCode = 1
    return
  }

  console.log(
    `IPC message floor: ${owners.length} IPC child owners, all floored${baseline.size > 0 ? ` (${baseline.size} grandfathered)` : ''}.`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
