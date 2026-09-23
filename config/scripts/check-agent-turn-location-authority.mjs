import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

const run = promisify(execFile)

// Who decides where a conversation turn runs.
//
// An agent declares a project, and that declaration is the authority for the turn's working
// directory. The failure this gate makes unrepeatable is not "the agent lacked context": it is that
// an ABSENT location silently became a plausible one. `conversations:sendTurn` used to resolve an
// empty cwd to `process.cwd()`, which on a packaged build is Orca's own install directory — so a
// project-scoped agent answered questions about Orca's packaged files, confidently, and nothing in
// the product could tell that apart from a real answer.
//
// So no module on the turn path may invent a location. `process.cwd()` is the specific invention
// that shipped; it is forbidden here rather than merely removed, because the next module to build a
// provider turn will reach for exactly the same convenience. A turn that cannot be located either
// gets its location from the agent's project or refuses.
//
// Comments are stripped first: the modules that honour this rule say so in prose, and a gate that
// accused its own documentation would be switched off within a week. Enumerated from git's index
// for the reason check-agent-identity-authority.mjs gives — a tracked file is what ships.

const TURN_PATH_PATHSPECS = ['src/main/conversation/*.ts', 'src/main/ipc/conversations.ts']
const TURN_PATH_FLOOR = 8
const INVENTED_LOCATION = /\bprocess\s*\.\s*cwd\s*\(/

/** Positive controls for the INSTRUMENT. A sweep that stopped reading code, or a turn path whose
 *  resolver was deleted, would otherwise report exactly what a clean one reports. */
const RESOLVER = 'src/main/conversation/agent-project-location.ts'
const TURN_RUNNER = 'src/main/conversation/conversation-turn-runner.ts'
/** Matches the CALL, not the declaration. `resolveProjectLocation: (agent) => ...` is a type; only
 *  `resolveProjectLocation(...)` is the runner actually asking. Measured: the bare-identifier
 *  version of this control stayed green while the call was replaced by a literal `no-project`, so
 *  it cleared a runner that had stopped consulting the agent's project entirely. */
const RESOLVER_CALL = /\bresolveProjectLocation\s*\(/
/** A remote-located turn must be ASKED for its remote driver; without the call, the only driver
 *  left is the local one, and a remote project's path would reach a local child process. */
const REMOTE_DRIVER_CALL = /\bremoteDriverFor\s*(?:\?\.)?\s*\(/

/** Pure: does the runner source still ask for a remote driver? Comments do not count. */
export function consultsRemoteDriver(runnerSource) {
  return REMOTE_DRIVER_CALL.test(stripComments(runnerSource))
}

export function isTestPath(filePath) {
  return /\.(test|spec)\.[cm]?tsx?$/.test(filePath)
}

/** Naive about comment markers inside string literals, which errs toward KEEPING text, i.e. toward
 *  accusing rather than excusing. */
export function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** Files are `{ path, source }`. Tests are exempt: they must be able to NAME the invention in order
 *  to assert it is gone. */
export function findInventedLocationSites(files) {
  return files
    .map((file) => ({ ...file, path: file.path.split(path.sep).join('/') }))
    .filter((file) => !isTestPath(file.path) && INVENTED_LOCATION.test(stripComments(file.source)))
    .map((file) => file.path)
    .sort()
}

async function gitLines(root, args) {
  try {
    const { stdout } = await run('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 })
    return {
      lines: stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    }
  } catch (error) {
    // `git grep` exits 1 with no output when nothing matched — an answer, not a failure.
    if (error?.code === 1 && typeof error.stdout === 'string' && error.stdout.trim() === '') {
      return { lines: [] }
    }
    return { lines: null, error: error?.shortMessage ?? error?.message ?? String(error) }
  }
}

export async function main(root = process.cwd(), log = console) {
  const failures = []

  const tracked = await gitLines(root, ['ls-files', '--', ...TURN_PATH_PATHSPECS])
  if (tracked.lines === null) {
    log.error(
      `❌  check-agent-turn-location-authority: could not list the turn path: ${tracked.error}`
    )
    return 1
  }
  if (tracked.lines.length < TURN_PATH_FLOOR) {
    failures.push(
      `found ${tracked.lines.length} tracked files on the turn path, expected at least ${TURN_PATH_FLOOR}; the sweep may have stopped seeing code`
    )
  }

  const files = await Promise.all(
    tracked.lines.map(async (file) => ({
      path: file,
      source: await readFile(path.join(root, file), 'utf8')
    }))
  )

  if (!files.some((file) => file.path === RESOLVER)) {
    failures.push(
      `${RESOLVER} is missing — nothing turns an agent's project into a working directory, so this gate would pass an unlocated turn`
    )
  }

  const runner = files.find((file) => file.path === TURN_RUNNER)
  if (!runner || !RESOLVER_CALL.test(stripComments(runner.source))) {
    failures.push(
      `${TURN_RUNNER} does not consult a project location — either the runner moved or the resolution was cut out, and an agent's project would stop deciding where its turn runs`
    )
  }

  if (runner && !consultsRemoteDriver(runner.source)) {
    failures.push(
      `${TURN_RUNNER} no longer asks for a remote driver — a remote project's turn would have only the local driver left, and its remote path would reach a local child process`
    )
  }

  for (const site of findInventedLocationSites(files)) {
    failures.push(
      `${site} calls process.cwd() on the conversation turn path; on a packaged build that is Orca's own install directory. A turn is located by the agent's project or it refuses`
    )
  }

  const aperture = `${tracked.lines.length} tracked files on the conversation turn path`
  if (failures.length > 0) {
    log.error(`❌  check-agent-turn-location-authority (${aperture}):`)
    for (const failure of failures) {
      log.error(`    - ${failure}`)
    }
    return 1
  }
  log.log(
    `✅  check-agent-turn-location-authority: the agent's project locates the turn (${RESOLVER}, consulted by ${TURN_RUNNER}); no invented location; swept ${aperture}.`
  )
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(await main())
}
