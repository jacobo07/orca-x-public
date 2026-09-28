import { execFile } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

const run = promisify(execFile)

// Who is allowed to mint an AgentId.
//
// Two opposite failures, one gate:
//
//   ZERO callers — the state this gate was written RED against on 2026-09-22. `mintAgentId` landed
//   in W-C1 with no production caller at all, which makes the durable roster a library rather than
//   a capability: nobody can create an agent, and every test around identity passes either way.
//
//   MANY callers — a renderer component that mints its own id has become a second identity
//   authority. The durable roster then has two answers to "who is this agent", which is the same
//   defect config/durable-actor-catalogs.jsonc exists to prevent, one layer down.
//
// So the assertion is EXACTLY ONE, and it names the file, because the point is not the count but
// WHICH module holds the authority — and that it is the one that can also persist the result.
//
// Why `git grep` rather than walking the tree: measured on the Windows dev host, reading every
// source file under src/ takes 170s for 95.7MB (Defender scans each read) and the same answer comes
// back from git's index in 596ms. Scoping to TRACKED files is also the more correct question for a
// repo gate — an untracked scratch file is not something the repository ships.

const SOURCE_PATHSPECS = ['src/*.ts', 'src/*.tsx']

/** The definition is not a caller. */
const DEFINITION = 'src/shared/agent-identity.ts'

// Floor, not a count: a sweep that silently stopped matching — a moved directory, a pathspec that
// no longer resolves, a git that is not there — returns zero callers and reads exactly like an
// estate with none. Measured 2026-09-22: 13,687 tracked source files.
const TRACKED_SOURCE_FLOOR = 9_000

const EXPECTED_AUTHORITIES = 1

/** Minting belongs to the process that owns the durable write; an id decided anywhere else was
 *  decided somewhere that cannot persist it. */
const AUTHORITY_PREFIX = 'src/main/'

export function isTestPath(filePath) {
  return /\.(test|spec)\.[cm]?tsx?$/.test(filePath)
}

/**
 * An invocation, not an import and not a type reference: `import { mintAgentId }` is how the one
 * legitimate caller reaches it, and counting that would make every re-export look like a mint.
 * The declaration in the definition file matches too, which is why it is excluded by path.
 */
export function classifyMintSites(files) {
  const authorities = []
  const excluded = []
  for (const file of files) {
    const normalized = file.split(path.sep).join('/')
    if (normalized === DEFINITION || isTestPath(normalized)) {
      excluded.push(normalized)
      continue
    }
    authorities.push(normalized)
  }
  return { authorities: authorities.sort(), excluded: excluded.sort() }
}

async function gitLines(root, args) {
  try {
    const { stdout } = await run('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 })
    return { lines: stdout.split('\n').map((line) => line.trim()).filter(Boolean) }
  } catch (error) {
    // `git grep` exits 1 with no output when nothing matched — that is an answer, not a failure.
    // Anything else means the instrument could not run, which must never read as a clean result.
    if (error?.code === 1 && typeof error.stdout === 'string' && error.stdout.trim() === '') {
      return { lines: [] }
    }
    return { lines: null, error: error?.shortMessage ?? error?.message ?? String(error) }
  }
}

export async function main(root = process.cwd(), log = console) {
  const failures = []

  const tracked = await gitLines(root, ['ls-files', '--', ...SOURCE_PATHSPECS])
  if (tracked.lines === null) {
    log.error(`❌  check-agent-identity-authority: could not list tracked sources: ${tracked.error}`)
    return 1
  }
  if (tracked.lines.length < TRACKED_SOURCE_FLOOR) {
    failures.push(
      `found ${tracked.lines.length} tracked source files, expected at least ${TRACKED_SOURCE_FLOOR}; the sweep may have stopped seeing code`
    )
  }

  const matched = await gitLines(root, [
    'grep',
    '-l',
    '-I',
    '-E',
    'mintAgentId[[:space:]]*\\(',
    '--',
    ...SOURCE_PATHSPECS
  ])
  if (matched.lines === null) {
    log.error(`❌  check-agent-identity-authority: could not sweep for callers: ${matched.error}`)
    return 1
  }

  const { authorities, excluded } = classifyMintSites(matched.lines)

  if (authorities.length !== EXPECTED_AUTHORITIES) {
    failures.push(
      authorities.length === 0
        ? `no production caller mints an AgentId — the durable agent roster exists and nothing can create an entry in it`
        : `${authorities.length} modules mint an AgentId (${authorities.join(', ')}), exactly ${EXPECTED_AUTHORITIES} may — a second minter is a second identity authority`
    )
  }

  for (const authority of authorities) {
    if (!authority.startsWith(AUTHORITY_PREFIX)) {
      failures.push(
        `${authority} mints an AgentId outside ${AUTHORITY_PREFIX} — identity must be minted by the process that owns the durable write`
      )
    }
  }

  const aperture = `${tracked.lines.length} tracked source files, ${excluded.length} non-production mint sites`
  if (failures.length > 0) {
    log.error(`❌  check-agent-identity-authority (${aperture}):`)
    for (const failure of failures) {
      log.error(`    - ${failure}`)
    }
    return 1
  }
  log.log(
    `✅  check-agent-identity-authority: ${authorities.join(', ')} is the only AgentId minter, swept ${aperture}.`
  )
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(await main())
}
