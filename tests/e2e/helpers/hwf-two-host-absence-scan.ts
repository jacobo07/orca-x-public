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
  capped: boolean
}

const CHUNK_BYTES = 1024 * 1024

function fileContainsAny(file: string, needles: Buffer[]): Set<number> | null {
  const found = new Set<number>()
  const overlap = Math.max(...needles.map((n) => n.length)) - 1
  let fd: number
  try {
    fd = openSync(file, 'r')
  } catch {
    return null
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
    return found
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

// Searches file CONTENT for nonces only; paths and terminal markers are references the client may legitimately persist.
export function scanLaptopForContentNonces(args: {
  roots: AbsenceScanRoot[]
  nonces: string[]
  maxFiles?: number
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
  let filesScanned = 0
  let filesUnreadable = 0
  let capped = false

  const visitFile = (file: string): void => {
    if (filesScanned >= maxFiles) {
      capped = true
      return
    }
    filesScanned += 1
    const found = fileContainsAny(file, needles)
    if (!found) {
      filesUnreadable += 1
      return
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
      filesUnreadable += 1
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
        filesUnreadable += 1
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

  const controlsFound = controlSeen.size
  const verdict =
    hits.length > 0
      ? 'FAIL'
      : controlsFound === controls.length && !capped
        ? 'PASS'
        : 'INCONCLUSIVE'
  return {
    verdict,
    hits,
    controlsFound,
    controlsPlanted: controls.length,
    filesScanned,
    filesUnreadable,
    capped
  }
}
