import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

const run = promisify(execFile)

// Which instruction slot an agent's role may reach.
//
// Codex's app-server offers two on thread/start and thread/resume, with opposite authority:
// `developerInstructions` is LAYERED above the provider's own base instructions, and
// `baseInstructions` REPLACES them. An agent role is text a user wrote. Routing it to the replacing
// slot would let that text override the layer that governs the provider — so no production source
// may use `baseInstructions` at all, and the one driver that speaks Codex must use the layered one.
//
// Comments are stripped first: the modules that honour this rule say so in prose, and a gate that
// accused its own documentation would be switched off within a week.
//
// Enumerated from git's index, as check-agent-identity-authority.mjs explains: 596ms against 170s
// for a tree walk on this host, and a tracked file is what the repository ships.

const SOURCE_PATHSPECS = ['src/*.ts', 'src/*.tsx']
const TRACKED_SOURCE_FLOOR = 9_000
const REPLACING_SLOT = 'baseInstructions'
const LAYERED_SLOT = 'developerInstructions'

/** Positive control for the INSTRUMENT: the layered slot must appear in code here, or the sweep is
 *  not reading code. It does not prove the slot is sent — `request.developerInstructions` alone
 *  satisfies it. That is proven by codex-conversation-driver.test.ts, driven red. */
const LAYERED_OWNER = 'src/main/codex/codex-conversation-driver.ts'

export function isTestPath(filePath) {
  return /\.(test|spec)\.[cm]?tsx?$/.test(filePath)
}

/** Removes block and line comments. Naive about comment markers inside string literals, which
 *  errs toward KEEPING text, i.e. toward accusing rather than excusing. */
export function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

export function usesSlotInCode(source, slot) {
  return new RegExp(`\\b${slot}\\b`).test(stripComments(source))
}

/** Files are `{ path, source }`. Tests are exempt: they must be able to NAME the slot to forbid it. */
export function findReplacingSlotSites(files) {
  return files
    .map((file) => ({ ...file, path: file.path.split(path.sep).join('/') }))
    .filter((file) => !isTestPath(file.path) && usesSlotInCode(file.source, REPLACING_SLOT))
    .map((file) => file.path)
    .sort()
}

async function gitLines(root, args) {
  try {
    const { stdout } = await run('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 })
    return { lines: stdout.split('\n').map((line) => line.trim()).filter(Boolean) }
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

  const tracked = await gitLines(root, ['ls-files', '--', ...SOURCE_PATHSPECS])
  if (tracked.lines === null) {
    log.error(`❌  check-agent-instruction-layer: could not list tracked sources: ${tracked.error}`)
    return 1
  }
  if (tracked.lines.length < TRACKED_SOURCE_FLOOR) {
    failures.push(
      `found ${tracked.lines.length} tracked source files, expected at least ${TRACKED_SOURCE_FLOOR}; the sweep may have stopped seeing code`
    )
  }

  const mentions = await gitLines(root, [
    'grep', '-l', '-I', '-E', `${REPLACING_SLOT}|${LAYERED_SLOT}`, '--', ...SOURCE_PATHSPECS
  ])
  if (mentions.lines === null) {
    log.error(`❌  check-agent-instruction-layer: could not sweep: ${mentions.error}`)
    return 1
  }

  const files = await Promise.all(
    mentions.lines.map(async (file) => ({
      path: file,
      source: await readFile(path.join(root, file), 'utf8')
    }))
  )

  const owner = files.find((file) => file.path === LAYERED_OWNER)
  if (!owner || !usesSlotInCode(owner.source, LAYERED_SLOT)) {
    failures.push(
      `${LAYERED_OWNER} does not send ${LAYERED_SLOT} in code — either the driver moved or the sweep is blind; an agent role would reach no provider`
    )
  }

  for (const site of findReplacingSlotSites(files)) {
    failures.push(
      `${site} uses ${REPLACING_SLOT}, which REPLACES the provider's base instructions — an agent role must only ever be layered (${LAYERED_SLOT})`
    )
  }

  const aperture = `${tracked.lines.length} tracked source files, ${files.length} mention an instruction slot`
  if (failures.length > 0) {
    log.error(`❌  check-agent-instruction-layer (${aperture}):`)
    for (const failure of failures) log.error(`    - ${failure}`)
    return 1
  }
  log.log(
    `✅  check-agent-instruction-layer: roles reach only ${LAYERED_SLOT} (${LAYERED_OWNER}); no production use of ${REPLACING_SLOT}; swept ${aperture}.`
  )
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(await main())
}
