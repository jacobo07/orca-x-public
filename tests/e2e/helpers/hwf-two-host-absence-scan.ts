import { randomBytes } from 'node:crypto'
import {
  closeSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  unlinkSync,
  writeFileSync,
  type Dirent
} from 'node:fs'
import path from 'node:path'

export type AbsenceScanRoot = {
  dir: string
  // Why: a shared temp dir holds gigabytes of unrelated files; only entries touched since the run began can carry a copy.
  modifiedSinceMs?: number
}

export type AbsenceScanResult = {
  verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE'
  hits: { nonce: string; file: string }[]
  controlsFound: number
  controlsPlanted: number
  filesScanned: number
  filesUnreadable: number
  unreadable: string[]
  // Unreadable paths under the userData root that no named reason covers; any one makes the verdict INCONCLUSIVE.
  unexplainedUnreadable: string[]
  capped: boolean
}

const CHUNK_BYTES = 1024 * 1024

// Measured in Run 4: the only unreadable userData paths were three `LOCK` files (Local Storage/leveldb, the orca-browser partition's Local Storage/leveldb, Session Storage).
// A path with no reason is not listed.
const KNOWN_UNREADABLE: { suffix: RegExp; reason: string }[] = [
  {
    suffix: /(^|\/)(leveldb|Session Storage)\/LOCK$/,
    reason:
      'LevelDB advisory-lock file Chromium holds exclusively while the app runs; empty by design, so it cannot hold a nonce'
  }
]

// The reason only covers a file that is actually empty, so the size is checked rather than assumed.
function isKnownUnreadable(file: string): boolean {
  const normalized = file.replace(/\\/g, '/')
  if (!KNOWN_UNREADABLE.some((entry) => entry.suffix.test(normalized))) {
    return false
  }
  try {
    return lstatSync(file).size === 0
  } catch {
    return false
  }
}

function isUnder(dir: string, file: string): boolean {
  const rel = path.relative(dir, file)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

// `complete` is false when the file could not be opened or a read failed midway; matches found before the failure are kept.
function fileContainsAny(
  file: string,
  needles: Buffer[]
): { found: Set<number>; complete: boolean } {
  const found = new Set<number>()
  const overlap = Math.max(...needles.map((n) => n.length)) - 1
  let fd: number
  try {
    fd = openSync(file, 'r')
  } catch {
    return { found, complete: false }
  }
  try {
    const buf = Buffer.alloc(CHUNK_BYTES + overlap)
    let carry = 0
    for (;;) {
      const read = readSync(fd, buf, carry, CHUNK_BYTES, null)
      if (read === 0) {
        break
      }
      const window = buf.subarray(0, carry + read)
      needles.forEach((needle, i) => {
        if (window.includes(needle)) {
          found.add(i)
        }
      })
      carry = Math.min(overlap, window.length)
      window.copy(buf, 0, window.length - carry)
    }
    return { found, complete: true }
  } catch {
    return { found, complete: false }
  } finally {
    closeSync(fd)
  }
}

export function logAbsenceScan(scan: AbsenceScanResult): void {
  console.log(
    `HWF_ABSENCE verdict=${scan.verdict} control=${scan.controlsFound === scan.controlsPlanted ? 'found' : 'missing'} hits=${scan.hits.length} files=${scan.filesScanned} unreadable=${scan.filesUnreadable} unexplained_unreadable=${scan.unexplainedUnreadable.length} capped=${scan.capped}`
  )
  // Hit files are named in the log so a FAIL is actionable; the nonce itself is never printed.
  for (const hit of scan.hits) {
    console.log(`HWF_ABSENCE_HIT ${hit.file}`)
  }
  for (const file of scan.unreadable) {
    console.log(`HWF_ABSENCE_UNREADABLE ${file}`)
  }
}

// Searches file CONTENT for nonces only; paths and terminal markers are references the client may legitimately persist.
export function scanLaptopForContentNonces(args: {
  roots: AbsenceScanRoot[]
  nonces: string[]
  maxFiles?: number
  userDataRoot?: string
}): AbsenceScanResult {
  const maxFiles = args.maxFiles ?? 200_000
  const controls = args.roots.map((root) => {
    const token = `HWF_ABSENCE_CONTROL_${randomBytes(8).toString('hex')}`
    const file = path.join(root.dir, `hwf-absence-control-${randomBytes(4).toString('hex')}.txt`)
    writeFileSync(file, token)
    return { token, file }
  })
  const needles = [...args.nonces, ...controls.map((c) => c.token)].map((s) => Buffer.from(s))
  const hits: AbsenceScanResult['hits'] = []
  const controlSeen = new Set<number>()
  const unreadable: string[] = []
  let filesScanned = 0
  let capped = false

  const visitFile = (file: string): void => {
    if (filesScanned >= maxFiles) {
      capped = true
      return
    }
    filesScanned += 1
    const { found, complete } = fileContainsAny(file, needles)
    if (!complete) {
      unreadable.push(file)
    }
    for (const i of found) {
      if (i < args.nonces.length) {
        hits.push({ nonce: args.nonces[i], file })
      } else {
        controlSeen.add(i - args.nonces.length)
      }
    }
  }

  const walk = (dir: string, sinceMs?: number): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      unreadable.push(dir)
      return
    }
    for (const entry of entries) {
      if (capped) {
        return
      }
      const full = path.join(dir, entry.name)
      let stat
      try {
        stat = lstatSync(full)
      } catch {
        unreadable.push(full)
        continue
      }
      if (stat.isSymbolicLink()) {
        continue
      }
      if (sinceMs !== undefined && stat.mtimeMs < sinceMs) {
        continue
      }
      if (stat.isDirectory()) {
        // Why: the mtime filter applies to top-level entries only; below one, everything is scanned.
        walk(full)
      } else if (stat.isFile()) {
        visitFile(full)
      }
    }
  }

  try {
    for (const root of args.roots) {
      walk(root.dir, root.modifiedSinceMs)
    }
  } finally {
    for (const control of controls) {
      try {
        unlinkSync(control.file)
      } catch {
        // The control is ours and already proved its point; a locked file is cleaned with the userData dir.
      }
    }
  }

  // Overlapping roots (userData lies inside the recent-temp root) visit a file twice.
  const uniqueUnreadable = [...new Set(unreadable)]
  const unexplainedUnreadable = args.userDataRoot
    ? uniqueUnreadable.filter(
        (file) => isUnder(args.userDataRoot!, file) && !isKnownUnreadable(file)
      )
    : []
  const controlsFound = controlSeen.size
  const verdict =
    hits.length > 0
      ? 'FAIL'
      : controlsFound === controls.length && !capped && unexplainedUnreadable.length === 0
        ? 'PASS'
        : 'INCONCLUSIVE'
  return {
    verdict,
    hits,
    controlsFound,
    controlsPlanted: controls.length,
    filesScanned,
    filesUnreadable: uniqueUnreadable.length,
    unreadable: uniqueUnreadable,
    unexplainedUnreadable,
    capped
  }
}
