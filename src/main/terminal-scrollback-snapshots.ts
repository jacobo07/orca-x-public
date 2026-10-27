import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readSync, rmSync, statSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { DurablePublishError, writeFileDurable, writeFileDurableSync } from './durable-file-write'
import {
  classifyScrollbackStoreFailure,
  type TerminalScrollbackStoreOutcome
} from './terminal-scrollback-store-outcome'
import type { WorkspaceSessionState } from '../shared/workspace-session-state-types'
import {
  TERMINAL_SCROLLBACK_REPLAY_BYTE_LIMIT,
  TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT
} from '../shared/terminal-scrollback-limits'

const SNAPSHOT_DIR_NAME = 'terminal-scrollback'
const REF_PREFIX = 'v1'

export type TerminalScrollbackSnapshotStorage = {
  snapshotRoot?: string
  fallbackSnapshotRoot?: string | null
}

function getLegacySnapshotRoot(): string {
  return join(app.getPath('userData'), SNAPSHOT_DIR_NAME)
}

export function getProfileTerminalScrollbackSnapshotRoot(dataFile: string): string {
  return join(dirname(dataFile), SNAPSHOT_DIR_NAME)
}

function getSnapshotRoot(storage?: TerminalScrollbackSnapshotStorage): string {
  return storage?.snapshotRoot ?? getLegacySnapshotRoot()
}

export function makeTerminalScrollbackSnapshotRef(tabId: string, leafId: string): string {
  const hash = createHash('sha256').update(`${tabId}\0${leafId}`).digest('hex').slice(0, 32)
  return `${REF_PREFIX}-${hash}`
}

function snapshotPath(ref: string, snapshotRoot: string): string | null {
  if (!/^v1-[0-9a-f]{32}$/.test(ref)) {
    return null
  }
  return join(snapshotRoot, `${ref}.bin`)
}

function snapshotReadPaths(ref: string, storage?: TerminalScrollbackSnapshotStorage): string[] {
  const primaryRoot = getSnapshotRoot(storage)
  const primaryPath = snapshotPath(ref, primaryRoot)
  if (!primaryPath) {
    return []
  }
  const fallbackRoot = storage?.fallbackSnapshotRoot ?? null
  if (!fallbackRoot || fallbackRoot === primaryRoot) {
    return [primaryPath]
  }
  const fallbackPath = snapshotPath(ref, fallbackRoot)
  return fallbackPath ? [primaryPath, fallbackPath] : [primaryPath]
}

/** Where a ref's bytes may live, primary first. Empty for a ref that is not canonical. */
export function resolveTerminalScrollbackSnapshotReadPaths(
  ref: string,
  storage: TerminalScrollbackSnapshotStorage
): string[] {
  return snapshotReadPaths(ref, storage)
}

function trailingUtf8Bytes(value: string, maxBytes: number): Buffer {
  const bytes = Buffer.from(value, 'utf-8')
  if (bytes.length <= maxBytes) {
    return bytes
  }
  let start = bytes.length - maxBytes
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) {
    start++
  }
  return bytes.subarray(start)
}

function readTrailingUtf8(path: string, maxBytes: number): string {
  const size = statSync(path).size
  const length = Math.min(size, maxBytes)
  if (length <= 0) {
    return ''
  }
  const bytes = Buffer.allocUnsafe(length)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, bytes, 0, length, size - length)
  } finally {
    closeSync(fd)
  }
  let start = 0
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) {
    start++
  }
  return bytes.subarray(start).toString('utf-8')
}

export function writeTerminalScrollbackSnapshotSync(args: {
  tabId: string
  leafId: string
  buffer: string
  storage?: TerminalScrollbackSnapshotStorage
}): TerminalScrollbackStoreOutcome {
  if (!args.buffer) {
    return { status: 'nothing-to-store' }
  }
  const ref = makeTerminalScrollbackSnapshotRef(args.tabId, args.leafId)
  const snapshotRoot = getSnapshotRoot(args.storage)
  const path = snapshotPath(ref, snapshotRoot)
  if (!path) {
    return { status: 'nothing-to-store' }
  }
  try {
    mkdirSync(snapshotRoot, { recursive: true, mode: 0o700 })
    const tmpPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
    const bytes = trailingUtf8Bytes(args.buffer, TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT)
    let renamed = false
    try {
      // Why durable: the session file holding this ref is fsynced, so an unsynced blob lets the
      // pointer outlive its referent and the restore reports the loss as empty scrollback.
      writeFileDurableSync(tmpPath, path, bytes, { mode: 0o600 })
      renamed = true
    } finally {
      if (!renamed) {
        rmSync(tmpPath, { force: true })
      }
    }
    return { status: 'stored', ref }
  } catch (err) {
    return notStored(err)
  }
}

/** The one place a thrown publish becomes an outcome, so both writers cannot classify differently. */
function notStored(err: unknown): TerminalScrollbackStoreOutcome {
  const stage = err instanceof DurablePublishError ? err.stage : null
  const code =
    err instanceof DurablePublishError
      ? err.code
      : ((err as NodeJS.ErrnoException | null)?.code ?? null)
  console.warn(
    `[terminal-scrollback] Failed to write snapshot${stage ? ` at ${stage}` : ''} (${code ?? 'no code'}): ${
      err instanceof Error ? err.message : String(err)
    }`
  )
  return {
    status: 'not-stored',
    failure: classifyScrollbackStoreFailure(typeof code === 'string' ? code : null),
    code: typeof code === 'string' ? code : null,
    stage
  }
}

export async function writeTerminalScrollbackSnapshot(args: {
  tabId: string
  leafId: string
  buffer: string
  storage?: TerminalScrollbackSnapshotStorage
}): Promise<TerminalScrollbackStoreOutcome> {
  if (!args.buffer) {
    return { status: 'nothing-to-store' }
  }
  const ref = makeTerminalScrollbackSnapshotRef(args.tabId, args.leafId)
  const snapshotRoot = getSnapshotRoot(args.storage)
  const path = snapshotPath(ref, snapshotRoot)
  if (!path) {
    return { status: 'nothing-to-store' }
  }
  const tmpPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  let renamed = false
  try {
    await mkdir(snapshotRoot, { recursive: true, mode: 0o700 })
    const bytes = trailingUtf8Bytes(args.buffer, TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT)
    // Why durable: same pointer-outlives-referent hazard as the sync path. The fsync runs on the
    // libuv threadpool, so the quit path's no-synchronous-syscall contract is preserved.
    await writeFileDurable(tmpPath, path, bytes, { mode: 0o600 })
    renamed = true
    return { status: 'stored', ref }
  } catch (err) {
    return notStored(err)
  } finally {
    if (!renamed) {
      await rm(tmpPath, { force: true }).catch(() => {})
    }
  }
}

export function readTerminalScrollbackSnapshotSync(
  ref: string,
  storage?: TerminalScrollbackSnapshotStorage
): string | null {
  for (const path of snapshotReadPaths(ref, storage)) {
    try {
      return readTrailingUtf8(path, TERMINAL_SCROLLBACK_REPLAY_BYTE_LIMIT)
    } catch {
      // Try the legacy/global fallback when a profile-local snapshot is absent.
    }
  }
  return null
}

export function deleteTerminalScrollbackSnapshotSync(
  ref: string,
  storage?: TerminalScrollbackSnapshotStorage
): void {
  for (const path of snapshotReadPaths(ref, storage)) {
    try {
      rmSync(path, { force: true })
    } catch {
      // Best-effort cleanup; stale refs are harmless and bounded by per-file caps.
    }
  }
}

export async function deleteTerminalScrollbackSnapshot(
  ref: string,
  storage?: TerminalScrollbackSnapshotStorage
): Promise<void> {
  await Promise.all(
    snapshotReadPaths(ref, storage).map((path) => rm(path, { force: true }).catch(() => {}))
  )
}

export function collectTerminalScrollbackSnapshotRefs(session: WorkspaceSessionState): Set<string> {
  const refs = new Set<string>()
  for (const layout of Object.values(session.terminalLayoutsByTabId ?? {})) {
    for (const ref of Object.values(layout.scrollbackRefsByLeafId ?? {})) {
      refs.add(ref)
    }
  }
  return refs
}

export function migrateWorkspaceSessionTerminalScrollbackSnapshots(
  session: WorkspaceSessionState,
  storage?: TerminalScrollbackSnapshotStorage
): { session: WorkspaceSessionState; changed: boolean } {
  let terminalLayoutsByTabId: WorkspaceSessionState['terminalLayoutsByTabId'] | null = null
  for (const [tabId, layout] of Object.entries(session.terminalLayoutsByTabId ?? {})) {
    const buffers = layout.buffersByLeafId
    if (!buffers || Object.keys(buffers).length === 0) {
      continue
    }
    const refs = { ...layout.scrollbackRefsByLeafId }
    const remainingBuffers: Record<string, string> = {}
    let layoutChanged = false
    for (const [leafId, buffer] of Object.entries(buffers)) {
      const outcome = writeTerminalScrollbackSnapshotSync({ tabId, leafId, buffer, storage })
      if (outcome.status === 'stored') {
        refs[leafId] = outcome.ref
        layoutChanged = true
      } else {
        // Same reasoning as the async sibling: the buffer is the only copy, so it stays inline
        // whether there was nothing to store or the store failed.
        remainingBuffers[leafId] = buffer
        if (refs[leafId]) {
          delete refs[leafId]
          layoutChanged = true
        }
      }
    }
    if (!layoutChanged) {
      continue
    }
    terminalLayoutsByTabId ??= { ...session.terminalLayoutsByTabId }
    const nextLayout = { ...layout }
    if (Object.keys(refs).length > 0) {
      nextLayout.scrollbackRefsByLeafId = refs
    } else {
      delete nextLayout.scrollbackRefsByLeafId
    }
    if (Object.keys(remainingBuffers).length > 0) {
      nextLayout.buffersByLeafId = remainingBuffers
    } else {
      delete nextLayout.buffersByLeafId
    }
    terminalLayoutsByTabId[tabId] = nextLayout
  }
  if (!terminalLayoutsByTabId) {
    return { session, changed: false }
  }
  return { session: { ...session, terminalLayoutsByTabId }, changed: true }
}
