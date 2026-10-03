import { readdir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'

// Why: only ENOENT/ENOTDIR say a listed path is gone; any other listing error (EIO, EACCES, EMFILE) is unknown.
export function rethrowUnlessAbsent(error: unknown): void {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code !== 'ENOENT' && code !== 'ENOTDIR') {
    throw error
  }
}

// Why: with no baseline yet an unlistable root has nothing to delete; the sentinel signature forces a rescan next tick.
export function unlistableBaseSnapshot(rootPath: string): {
  markers: Map<string, boolean>
  gateDirs: string[]
  gateSignatures: string[]
} {
  return { markers: new Map(), gateDirs: [rootPath], gateSignatures: ['unlistable'] }
}

// Why: a nested repo container that is gone has no children; one that failed to list is unknown and rethrows.
export async function listNestedContainer(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch (error) {
    rethrowUnlessAbsent(error)
    return []
  }
}
