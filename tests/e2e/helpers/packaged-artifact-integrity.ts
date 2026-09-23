/**
 * Whether the packaged artifact a spec is about to launch actually contains the current build.
 *
 * Two properties, checked separately because they fail separately: freshness (is the artifact newer
 * than `out/`) and integrity (does its asar hold the bytes `out/` holds). Both are preconditions: a
 * refusal says the run could not judge the product, never that the product is wrong.
 */

import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import path from 'node:path'
import { PRECONDITION_FAILURE_MARKER } from './e2e-precondition'

function mtimeOrNull(target: string): number | null {
  try {
    return statSync(target).mtimeMs
  } catch {
    return null
  }
}

/**
 * Refuse to run against an artifact older than the build output it is supposed to contain.
 *
 * `PACKAGED_ORCA_APP_DIR` defaults to a directory under the system temp folder that nothing in this
 * repository creates or refreshes — it is staged by hand. So `pnpm run build:unpack` writes
 * `dist/win-unpacked` and leaves whatever the packaged specs actually launch untouched, and a fix can
 * be absent at runtime while being present in every artifact you think to inspect. That reads as a
 * product defect, reproducibly, and the checks that would rule it out (is the symbol in the asar, is
 * the call in the emitted chunk) all pass, because they are aimed at a build nobody is running.
 *
 * `out/` is what the packaging step consumes, so `out/` newer than the artifact means it cannot
 * contain the current build. This is a precondition: it says the run could not judge the product,
 * not that the product is wrong.
 *
 * Which file inside the artifact answers "when was this last built" is load-bearing, and the
 * executable alone is the wrong answer. It carries Electron; the asar carries the application code
 * every one of these specs is about, and restaging just the asar is a normal way to refresh the
 * artifact — it leaves the executable's timestamp untouched. Judging by the executable therefore
 * refuses a current artifact and sends you into a full repackage to answer a question the asar had
 * already answered. So the artifact's age is the newest of its two carriers, and a missing asar
 * falls back to the executable rather than becoming a refusal of its own.
 */
export function assertPackagedArtifactIsNotStale(
  executablePath: string,
  projectRoot: string = process.cwd()
): void {
  const carriers = [
    mtimeOrNull(executablePath),
    mtimeOrNull(path.join(path.dirname(executablePath), 'resources', 'app.asar'))
  ].filter((value): value is number => value !== null)
  if (carriers.length === 0) {
    return
  }
  const builtAt = Math.max(...carriers)
  const sources = [
    path.join(projectRoot, 'out', 'main', 'index.js'),
    path.join(projectRoot, 'out', 'renderer', 'index.html')
  ]
    .map(mtimeOrNull)
    .filter((value): value is number => value !== null)
  if (sources.length === 0) {
    // No build output to compare against, so this cannot say anything either way.
    return
  }
  const newestSource = Math.max(...sources)
  if (newestSource <= builtAt) {
    return
  }
  throw new Error(
    // The directory actually judged, not the module default: a caller pointing elsewhere with
    // ORCA_E2E_PACKAGED_APP_DIR would otherwise be sent to rebuild a directory nobody launched.
    `${PRECONDITION_FAILURE_MARKER} the packaged artifact at ${path.dirname(executablePath)} was built ` +
      `${new Date(builtAt).toISOString()}, before the current build output ` +
      `(${new Date(newestSource).toISOString()}). It cannot contain the change under test. Rebuild ` +
      `into that directory, or point ORCA_E2E_PACKAGED_APP_DIR at the build you mean to exercise.`
  )
}

/** Enough of the entry to characterise it without reading ten megabytes on every launch. */
const MAIN_BUNDLE_COMPARE_BYTES = 4096

/**
 * `integrity` is what the packer recorded for the bytes it meant to write, so it is the only thing
 * that can tell an archive which disagrees with ITSELF from an archive which merely holds a
 * different build. Optional, because not every packer writes it and its absence is not a verdict.
 */
type AsarEntry = { offset: string; size: number; integrity?: { hash?: string } }

/**
 * The archive's own index, so an entry can be read at the offset the runtime will read it from.
 *
 * Header layout: a 4-byte pickle length, the pickle size, the payload size, then the JSON length,
 * then the JSON itself; file bodies begin at 8 + pickleSize and entry offsets are relative to that.
 * Returns null for anything unparseable — an archive this cannot read is not an archive this may
 * pass judgement on.
 */
function readAsarMainEntry(handle: number): { entry: AsarEntry; filesStart: number } | null {
  try {
    const head = Buffer.alloc(16)
    if (readSync(handle, head, 0, 16, 0) < 16) {
      return null
    }
    const pickleSize = head.readUInt32LE(4)
    const jsonSize = head.readUInt32LE(12)
    if (jsonSize <= 0 || jsonSize > 64 * 1024 * 1024) {
      return null
    }
    const json = Buffer.alloc(jsonSize)
    readSync(handle, json, 0, jsonSize, 16)
    const index = JSON.parse(json.toString('utf8')) as {
      files?: Record<string, { files?: Record<string, unknown> }>
    }
    const entry = (
      index.files?.out?.files?.main as { files?: Record<string, AsarEntry> } | undefined
    )?.files?.['index.js']
    if (!entry || typeof entry.offset !== 'string') {
      return null
    }
    return { entry, filesStart: 8 + pickleSize }
  } catch {
    return null
  }
}

/**
 * Refuse an artifact that is current and still does not contain the build.
 *
 * Freshness and integrity are different properties and the check above only has the first. Measured
 * here: a packaged `app.asar` produced minutes after the build, holding an `out/main/index.js` whose
 * first 52 bytes were a fragment of the preload bundle — the tail of `contextBridge.executeInMainWorld`
 * — with 52 bytes missing from its end. The app exited 1 before opening a window. Every timestamp
 * said the artifact was current, because it was; it simply was not the file. Length agreed too.
 *
 * The cause is ordinary on a shared checkout: the packer read `out/` while another process rewrote
 * it. That is a hazard to detect rather than a rule to ask people to obey.
 *
 * The entry is read at its indexed offset and compared byte for byte, because the corruption that
 * motivated this PREPENDED rather than replaced: the built bytes were still present in the archive,
 * merely shifted. A search for "the built bytes appear somewhere" therefore passed it — the first
 * version of this guard did exactly that and had to be measured against the real artifact before
 * the hole showed. A missing archive, unreadable index or missing build output says nothing either
 * way and must not manufacture a verdict.
 */
export function assertPackagedMainMatchesBuild(
  executablePath: string,
  projectRoot: string = process.cwd()
): void {
  const builtMain = path.join(projectRoot, 'out', 'main', 'index.js')
  const archive = path.join(path.dirname(executablePath), 'resources', 'app.asar')
  if (!existsSync(builtMain) || !existsSync(archive)) {
    return
  }

  const handle = openSync(archive, 'r')
  let packed: Buffer
  let packedSize: number
  let recordedHash: string | null
  try {
    const located = readAsarMainEntry(handle)
    if (!located) {
      return
    }
    packedSize = located.entry.size
    recordedHash = located.entry.integrity?.hash ?? null
    const want = Math.min(MAIN_BUNDLE_COMPARE_BYTES, packedSize)
    packed = Buffer.alloc(want)
    readSync(handle, packed, 0, want, located.filesStart + Number(located.entry.offset))
  } finally {
    closeSync(handle)
  }

  const built = readFileSync(builtMain)
  const mismatch = built.length !== packedSize || !built.subarray(0, packed.length).equals(packed)
  if (!mismatch) {
    return
  }
  throw new Error(
    `${PRECONDITION_FAILURE_MARKER} the packaged artifact at ${path.dirname(executablePath)} ` +
      `does not contain the built main bundle: its app.asar entry for out/main/index.js is ` +
      `${packedSize} bytes against ${built.length} on disk, and its opening bytes differ. This run ` +
      `would measure code nobody built. ${diagnoseArchiveMismatch(archive, recordedHash)}`
  )
}

/**
 * Which of the two failures this is, because they are fixed in different places.
 *
 * Reading the entry's bytes and hashing them answers it against the packer's own record:
 *
 *   they agree     -> the archive is internally sound and simply holds a DIFFERENT build. Repackage.
 *   they disagree  -> the archive contradicts its own index, so it was corrupted while being
 *                     written, and repackaging without removing the cause will reproduce it.
 *
 * The mechanism behind the second, measured 2026-09-13: electron-builder records an entry's length
 * from a stat and writes its bytes afterwards, so a packed file that SHRINKS in between leaves every
 * later entry sitting earlier than the index says, by exactly the difference. A Stop hook rewrote
 * `BLOCKED_DELIVERY.md` from 9,619 bytes to 1,089 mid-pack and shifted the rest of the archive
 * 8,530 bytes — `out/main/index.js` verified perfectly at `offset - 8530` and was garbage at
 * `offset`. Nothing in the build reported it: the packager had finished, signed and exited 0.
 *
 * Only reached on the failure path, so hashing ten megabytes costs nothing on a healthy launch.
 */
function diagnoseArchiveMismatch(archive: string, recordedHash: string | null): string {
  if (!recordedHash) {
    return (
      'The archive records no integrity hash for that entry, so this cannot tell a corrupted ' +
      'archive from one holding a different build. Repackage with nothing else writing to the tree.'
    )
  }
  const handle = openSync(archive, 'r')
  let actualHash: string | null = null
  try {
    const located = readAsarMainEntry(handle)
    if (located) {
      const whole = Buffer.alloc(located.entry.size)
      readSync(handle, whole, 0, whole.length, located.filesStart + Number(located.entry.offset))
      actualHash = createHash('sha256').update(whole).digest('hex')
    }
  } catch {
    actualHash = null
  } finally {
    closeSync(handle)
  }
  if (actualHash === recordedHash) {
    return (
      'The archive agrees with its own index, so it is sound and simply contains a different ' +
      'build than out/ currently holds. Rebuild and repackage.'
    )
  }
  return (
    'The bytes at that offset do not match the hash the packer recorded for them, so the archive ' +
    'contradicts its own index: something rewrote a packed file while the packer was reading it, ' +
    'shifting every later entry. Repackaging alone will reproduce this — find the writer first ' +
    '(agent session artifacts at the repo root are the usual one) and exclude it from `files`.'
  )
}
