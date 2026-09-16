// Why: rename() is atomic for readers but not durable. Without fsync on the file and its directory,
// a power loss after a successful rename can leave the old contents, or an empty inode — the same
// empty-file symptom as issue #1158, from a different cause. The .bak ring recovers it at up to an
// hour's loss; fsync stops it from happening.

import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { link, open, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** `mode` is applied when the temp file is created, so the payload is never briefly world-readable. */
export type DurableWriteOptions = { mode?: number }

/**
 * fsync a directory so a rename within it is durable. Best-effort by design: Windows cannot open a
 * directory for fsync, and some filesystems reject it. The file fsync above it is the load-bearing
 * part; this closes the "rename recorded but not persisted" window where the platform allows it.
 */
async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(directory, 'r')
    await handle.sync()
  } catch {
    // Expected on Windows and on filesystems without directory fsync.
  } finally {
    await handle?.close().catch(() => {})
  }
}

function syncDirectorySync(directory: string): void {
  let fd: number | null = null
  try {
    fd = openSync(directory, 'r')
    fsyncSync(fd)
  } catch {
    // Same platform caveats as syncDirectory.
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // Nothing actionable; the fsync already happened or the open failed.
      }
    }
  }
}

/**
 * Rename and then fsync the containing directory. For callers that already fsynced the temp file
 * themselves and need the rename made durable.
 */
export async function renameDurable(tmpPath: string, finalPath: string): Promise<void> {
  await rename(tmpPath, finalPath)
  await syncDirectory(dirname(finalPath))
}

/** Write `payload` to `tmpPath`, fsync it, then rename onto `finalPath` and fsync the directory. */
export async function writeFileDurable(
  tmpPath: string,
  finalPath: string,
  payload: string | Buffer,
  options: DurableWriteOptions = {}
): Promise<void> {
  await writeFileDurableIfCurrent(tmpPath, finalPath, payload, () => true, options)
}

/**
 * `writeFileDurable` with a commit veto: `isCurrent` is consulted after the fsync and before the
 * rename so a writer that was superseded mid-write doesn't publish a stale snapshot. Returns whether
 * the rename happened; the temp file is removed on every path that doesn't commit, so a multi-MB
 * payload can't orphan itself.
 */
export async function writeFileDurableIfCurrent(
  tmpPath: string,
  finalPath: string,
  payload: string | Buffer,
  isCurrent: () => boolean,
  options: DurableWriteOptions = {}
): Promise<boolean> {
  let renamed = false
  try {
    const handle = await open(tmpPath, 'w', options.mode)
    try {
      await handle.writeFile(payload)
      // Why: fsync BEFORE rename. A rename that lands first can expose a zero-length file.
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (!isCurrent()) {
      return false
    }
    await rename(tmpPath, finalPath)
    renamed = true
    await syncDirectory(dirname(finalPath))
    return true
  } finally {
    if (!renamed) {
      await rm(tmpPath, { force: true }).catch(() => {})
    }
  }
}

export type DurablePublishStage = 'write' | 'barrier' | 'publish'

/** Names the step that failed, so a caller can tell "nothing was written" from "not flushed". */
export class DurablePublishError extends Error {
  readonly stage: DurablePublishStage
  /** The OS error code; EEXIST at `publish` means the final name was already taken. */
  readonly code: string | null

  constructor(stage: DurablePublishStage, cause: unknown) {
    super(
      `durable publish failed at ${stage}: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        cause
      }
    )
    this.name = 'DurablePublishError'
    this.stage = stage
    const code = (cause as NodeJS.ErrnoException | null)?.code
    this.code = typeof code === 'string' ? code : null
  }
}

/**
 * `writeFileDurable` for immutable artifacts: publishes by hard link, which fails with EEXIST
 * instead of replacing an existing file the way rename does. Throws `DurablePublishError`; the temp
 * file is removed on every path.
 */
export async function writeFileDurableExclusive(
  tmpPath: string,
  finalPath: string,
  payload: string | Buffer,
  options: DurableWriteOptions = {}
): Promise<void> {
  let stage: DurablePublishStage = 'write'
  try {
    const handle = await open(tmpPath, 'wx', options.mode)
    try {
      await handle.writeFile(payload)
      stage = 'barrier'
      await handle.sync()
    } finally {
      await handle.close()
    }
    stage = 'publish'
    await link(tmpPath, finalPath)
  } catch (error) {
    throw new DurablePublishError(stage, error)
  } finally {
    // Why unconditional: after a successful link the temp is a second name for the published bytes.
    await rm(tmpPath, { force: true }).catch(() => {})
  }
  await syncDirectory(dirname(finalPath))
}

/** Temp path for a durable write. Shared shape so `removeStaleDurableWriteTempFiles` can reclaim orphans. */
export function durableWriteTempPath(finalPath: string): string {
  return `${finalPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
}

/**
 * Sweep temp files orphaned by a death between write and rename — for multi-MB payloads they would
 * otherwise accumulate forever. Callers can require a minimum age to spare another live instance's
 * write. This process's own temps are always skipped because deleting one would fail its rename.
 */
export async function removeStaleDurableWriteTempFiles(
  finalPath: string,
  options: { minimumAgeMs?: number } = {}
): Promise<void> {
  const directory = dirname(finalPath)
  const prefix = `${basename(finalPath)}.`
  const ownPrefix = `${prefix}${process.pid}.`
  try {
    const names = await readdir(directory)
    await Promise.all(
      names
        .filter(
          (name) => name.startsWith(prefix) && name.endsWith('.tmp') && !name.startsWith(ownPrefix)
        )
        .map(async (name) => {
          const path = join(directory, name)
          if (options.minimumAgeMs) {
            const info = await stat(path).catch(() => null)
            if (!info || Date.now() - info.mtimeMs < options.minimumAgeMs) {
              return
            }
          }
          await rm(path, { force: true }).catch(() => {})
        })
    )
  } catch {
    // Directory missing or unreadable — nothing to sweep.
  }
}

/**
 * Synchronous counterpart for quit and crash paths that cannot await. Like the async variant, the
 * temp file is removed on every path that doesn't commit — cleanup belongs to the primitive, since
 * a caller that has to remember it is a caller that can forget. Only the failure path unlinks, so a
 * successful quit write issues no extra syscall.
 */
export function writeFileDurableSync(
  tmpPath: string,
  finalPath: string,
  payload: string | Buffer,
  options: DurableWriteOptions = {}
): void {
  let renamed = false
  try {
    writeFileSync(tmpPath, payload, { mode: options.mode })
    const fd = openSync(tmpPath, 'r+')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmpPath, finalPath)
    renamed = true
    syncDirectorySync(dirname(finalPath))
  } finally {
    if (!renamed) {
      try {
        rmSync(tmpPath, { force: true })
      } catch {
        // The write already failed; a secondary cleanup error must not mask it.
      }
    }
  }
}
