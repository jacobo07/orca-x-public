import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import type {
  WorkingSetScopeKey,
  WorkingSetScrollbackSealReport
} from '../../shared/project-working-set-store-types'
import type { ProjectWorkingSetManifest } from '../../shared/project-working-set-types'
import { TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT } from '../../shared/terminal-scrollback-limits'
import {
  durableWriteTempPath,
  syncDirectory,
  writeFileDurableExclusive
} from '../durable-file-write'
import {
  makeTerminalScrollbackSnapshotRef,
  resolveTerminalScrollbackSnapshotReadPaths,
  type TerminalScrollbackSnapshotStorage
} from '../terminal-scrollback-snapshots'
import { workingSetPartitionName } from './working-set-store-layout'

/**
 * A working set's own copy of each pane's scrollback.
 *
 * Why a copy: the live scrollback file is named by tab and leaf, rewritten on every session save
 * and deleted once the tab leaves the session, so a manifest pointing at it would name bytes that
 * change after sealing and then disappear. The copy is taken from the last persisted session, so
 * it is history as of that write, not as of the save click.
 *
 * Layout: `<root>/sealed-scrollback/<partition>/<workingSetId>/<ref>.bin`, outside every partition
 * directory so a listing never sees it.
 */

const SEAL_DIR_NAME = 'sealed-scrollback'
const SEAL_SUFFIX = '.bin'

export type SealedScrollbackPresence = 'present' | 'absent' | 'unknown'

function sealDir(root: string, scope: WorkingSetScopeKey, workingSetId: string): string {
  return join(root, SEAL_DIR_NAME, workingSetPartitionName(scope), workingSetId)
}

function sealPath(dir: string, tabId: string, leafId: string): string {
  return join(dir, `${makeTerminalScrollbackSnapshotRef(tabId, leafId)}${SEAL_SUFFIX}`)
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' ? code : 'UNKNOWN'
}

async function readSourceBytes(
  refs: readonly string[],
  storage: TerminalScrollbackSnapshotStorage
): Promise<Buffer | null> {
  for (const path of refs.flatMap((ref) =>
    resolveTerminalScrollbackSnapshotReadPaths(ref, storage)
  )) {
    let size: number
    try {
      size = (await stat(path)).size
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        continue
      }
      throw error
    }
    if (size > TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT) {
      throw Object.assign(new Error(`scrollback of ${size} bytes`), { code: 'EFBIG' })
    }
    return readFile(path)
  }
  return null
}

/** Every created level's entry lives in its parent, so each of those parents is synced. */
async function syncCreatedChain(dir: string, firstCreated: string | undefined): Promise<void> {
  if (!firstCreated) {
    return
  }
  const depth = relative(firstCreated, dir).split(sep).filter(Boolean).length
  let level = dir
  for (let i = 0; i <= depth; i++) {
    await syncDirectory(dirname(level))
    level = dirname(level)
  }
}

/**
 * Copies every pane's persisted scrollback durably. Must finish before the manifest is published:
 * the manifest is the durable pointer, and these are its referents.
 */
export async function sealWorkingSetScrollback(
  root: string,
  manifest: ProjectWorkingSetManifest,
  storage: TerminalScrollbackSnapshotStorage
): Promise<WorkingSetScrollbackSealReport> {
  const dir = sealDir(root, manifest.scope, manifest.workingSetId)
  const report: WorkingSetScrollbackSealReport = { sealed: 0, absent: 0, failed: [] }
  let dirReady = false
  // Why sequential: each copy is up to the store cap; one at a time bounds memory.
  for (const entry of manifest.entries) {
    for (const pane of entry.panes) {
      // Why the recorded ref first: a leaf-id rewrite keeps the old ref, so it can differ from the
      // one derived from today's ids; the derived one covers panes the renderer recorded as null.
      const derived = makeTerminalScrollbackSnapshotRef(entry.tabId, pane.leafId)
      const refs = [...new Set([pane.scrollbackRef ?? derived, derived])]
      try {
        const bytes = await readSourceBytes(refs, storage)
        if (!bytes) {
          report.absent++
          continue
        }
        if (!dirReady) {
          await syncCreatedChain(dir, await mkdir(dir, { recursive: true, mode: 0o700 }))
          dirReady = true
        }
        const target = sealPath(dir, entry.tabId, pane.leafId)
        await writeFileDurableExclusive(durableWriteTempPath(target), target, bytes, {
          mode: 0o600
        })
        report.sealed++
      } catch (error) {
        report.failed.push({ tabId: entry.tabId, leafId: pane.leafId, code: errorCode(error) })
      }
    }
  }
  return report
}

/** Best-effort removal of copies whose manifest never got published. */
export async function discardWorkingSetScrollback(
  root: string,
  scope: WorkingSetScopeKey,
  workingSetId: string
): Promise<void> {
  await rm(sealDir(root, scope, workingSetId), { recursive: true, force: true }).catch(() => {})
}

export async function readSealedScrollbackPresence(
  root: string,
  scope: WorkingSetScopeKey,
  workingSetId: string,
  tabId: string,
  leafId: string
): Promise<SealedScrollbackPresence> {
  try {
    const info = await stat(sealPath(sealDir(root, scope, workingSetId), tabId, leafId))
    return info.isFile() ? 'present' : 'unknown'
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? 'absent' : 'unknown'
  }
}

export async function readSealedScrollback(
  root: string,
  scope: WorkingSetScopeKey,
  workingSetId: string,
  tabId: string,
  leafId: string
): Promise<Buffer | null> {
  try {
    return await readFile(sealPath(sealDir(root, scope, workingSetId), tabId, leafId))
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return null
    }
    throw error
  }
}
