#!/usr/bin/env node
// What did that image-generation turn actually produce?
//
// Not "what did the agent say it produced". Codex's imagegen skill lives outside the
// workspace sandbox, so a run routinely reports "policy blocked reading the imagegen skill"
// and "read-only filesystem, no file was created" -- and writes the PNG anyway. A refusal
// message and a successful generation are the same text. The filesystem is the only witness.
//
// It also answers the size question honestly: a "512x512" request was observed returning
// 1254x1254, so the dimensions here are read out of each file's PNG header rather than taken
// from whatever was asked for.
//
//   node config/scripts/codex-generated-image-discovery.mjs [--since <iso>] [--json]
//
// Exit 0 with a listing, or 2 when the store could not be read -- "I could not look" must
// never render as "nothing was generated".
import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const EXIT_OK = 0
export const EXIT_CANNOT_LOOK = 2

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// Discovered, never hardcoded. The CODEX_HOME in play on a given machine depends on whether
// Codex was launched standalone or by Orca's managed runtime, and pinning one absolute path
// is how this stops working on the next machine.
export function codexHomeCandidates(env = process.env, homedir = os.homedir()) {
  const candidates = []
  if (env.CODEX_HOME) {
    candidates.push({ path: env.CODEX_HOME, source: 'CODEX_HOME' })
  }
  const appData = env.APPDATA ?? path.join(homedir, 'AppData', 'Roaming')
  candidates.push({
    path: path.join(appData, 'orca', 'codex-runtime-home', 'home'),
    source: "Orca's managed Codex runtime home"
  })
  candidates.push({ path: path.join(homedir, '.codex'), source: 'standalone Codex home' })
  return candidates
}

export async function resolveGeneratedImageRoot(candidates) {
  const tried = []
  for (const candidate of candidates) {
    const root = path.join(candidate.path, 'generated_images')
    try {
      const info = await stat(root)
      if (info.isDirectory()) {
        return { root, source: candidate.source, tried }
      }
      tried.push(`${root} (not a directory)`)
    } catch {
      tried.push(root)
    }
  }
  return { root: null, tried }
}

// Width and height straight out of the IHDR chunk. A file that is not a PNG, or is truncated
// mid-header, returns null rather than a guess: a candidate asset whose dimensions we cannot
// read is not a candidate asset whose dimensions are zero.
export function readPngDimensions(buffer) {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return null
  }
  if (buffer.subarray(12, 16).toString('ascii') !== 'IHDR') {
    return null
  }
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  if (width === 0 || height === 0) {
    return null
  }
  return { width, height }
}

async function collectPngs(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectPngs(full)))
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.png')) {
      files.push(full)
    }
  }
  return files
}

export async function discoverGeneratedImages({ root, since = null } = {}) {
  const files = await collectPngs(root)
  const images = []
  for (const file of files) {
    const info = await stat(file)
    const bytes = await readFile(file)
    const dimensions = readPngDimensions(bytes)
    // The thread directory is the only grouping Codex gives us, and it is what ties a file
    // back to the turn that made it.
    const relative = path.relative(root, file)
    images.push({
      thread: path.dirname(relative).split(path.sep)[0] ?? null,
      file,
      relative,
      bytes: info.size,
      modified: info.mtime.toISOString(),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      // null, never 0: unreadable dimensions are unknown dimensions.
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
      isNew: since === null ? null : info.mtime.getTime() > Date.parse(since)
    })
  }
  images.sort((a, b) => a.modified.localeCompare(b.modified))
  return images
}

export async function main({ argv = [], env = process.env, log = console.log, error = console.error } = {}) {
  const sinceIndex = argv.indexOf('--since')
  const since = sinceIndex === -1 ? null : (argv[sinceIndex + 1] ?? null)
  if (sinceIndex !== -1 && (since === null || Number.isNaN(Date.parse(since)))) {
    error(`--since needs an ISO timestamp; got ${String(since)}`)
    return EXIT_CANNOT_LOOK
  }
  const asJson = argv.includes('--json')

  const { root, source, tried } = await resolveGeneratedImageRoot(codexHomeCandidates(env))
  if (root === null) {
    error('No Codex generated_images store found. Looked in:')
    for (const candidate of tried) {
      error(`  - ${candidate}`)
    }
    error('This is "could not look", not "nothing was generated".')
    return EXIT_CANNOT_LOOK
  }

  let images
  try {
    images = await discoverGeneratedImages({ root, since })
  } catch (cause) {
    error(`Found ${root} but could not read it: ${cause.message}`)
    return EXIT_CANNOT_LOOK
  }

  if (asJson) {
    log(JSON.stringify({ root, source, since, images }, null, 2))
    return EXIT_OK
  }

  log(`${root}  (${source})`)
  const shown = since === null ? images : images.filter((image) => image.isNew)
  if (shown.length === 0) {
    log(since === null ? 'No generated images.' : `No images newer than ${since}.`)
    return EXIT_OK
  }
  for (const image of shown) {
    const size = image.width === null ? 'dimensions unreadable' : `${image.width}x${image.height}`
    log(
      `${image.modified}  ${size.padEnd(22)} ${String(image.bytes).padStart(9)} B  ${image.sha256.slice(0, 12)}  ${image.relative}`
    )
  }
  log(`${shown.length} image(s)${since === null ? '' : ` newer than ${since}`}, of ${images.length} in the store.`)
  return EXIT_OK
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  process.exit(await main({ argv: process.argv.slice(2) }))
}
