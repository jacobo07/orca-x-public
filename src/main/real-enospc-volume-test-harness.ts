// Shared opt-in guard and fill for the tests that put a writer on a REAL bounded filesystem.
// ORCA_ENOSPC_VOLUME is read at call time so a test file decides its own skip at collection.
import { statfsSync, writeFileSync } from 'node:fs'

const MAX_VOLUME_BYTES = 64 * 1024 * 1024

export function realEnospcVolume(): string {
  return process.env.ORCA_ENOSPC_VOLUME ?? ''
}

export function realEnospcVolumeUnusableReason(): string | null {
  const volume = realEnospcVolume()
  if (!volume) {
    return 'ORCA_ENOSPC_VOLUME is not set'
  }
  let info: ReturnType<typeof statfsSync>
  try {
    info = statfsSync(volume)
  } catch (error) {
    return `ORCA_ENOSPC_VOLUME is not a mounted filesystem: ${(error as Error).message}`
  }
  const totalBytes = Number(info.blocks) * Number(info.bsize)
  // A guard against being pointed at a real disk: filling / would take the machine down.
  if (totalBytes > MAX_VOLUME_BYTES) {
    return `refusing to fill a ${Math.round(totalBytes / 1024 / 1024)}MB volume; point this at a small loopback image`
  }
  return null
}

export function fillRealEnospcVolume(ballastPath: string): number {
  // Why descending sizes: the last successful write leaves the volume as close to full as the
  // filesystem allows, so the subject's own write is the one that runs out of room.
  let wrote = 0
  for (const size of [1024 * 1024, 256 * 1024, 64 * 1024, 8 * 1024, 1024, 128]) {
    for (;;) {
      try {
        writeFileSync(ballastPath, Buffer.alloc(wrote + size), { flag: 'w' })
        wrote += size
      } catch {
        break
      }
    }
  }
  return wrote
}
