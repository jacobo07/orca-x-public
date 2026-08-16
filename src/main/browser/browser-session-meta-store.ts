import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { BrowserSessionProfile } from '../../shared/browser-workspace-types'

// Why the states are kept apart: absent is a legitimate first run, corrupt never self-heals, and
// unreadable is usually transient. Collapsing them lets a momentary lock erase real profiles.
type BrowserSessionMetaRead =
  | { status: 'ok'; meta: BrowserSessionMeta }
  | { status: 'absent' }
  | { status: 'corrupt'; reason: string }
  | { status: 'unreadable'; reason: string }

// Why: no userAgent fields — the session UA is always derived from the running
// engine at startup (clean or native), never persisted. Imports before Aug 2026
// stored a synthesized source-browser UA here; persistMeta drops those legacy
// keys on the next write because this loader no longer carries them.
export type BrowserSessionMeta = {
  defaultSource: BrowserSessionProfile['source']
  pendingCookieDbPath: string | null
  pendingCookieImports: Record<string, string>
  profiles: BrowserSessionProfile[]
}

export const BROWSER_SESSION_META_FILE_NAME = 'browser-session-meta.json'

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function emptyBrowserSessionMeta(): BrowserSessionMeta {
  return {
    defaultSource: null,
    pendingCookieDbPath: null,
    pendingCookieImports: {},
    profiles: []
  }
}

// Why: the path is resolved lazily (app.getPath('userData') throws pre-ready) so that failure
// classifies as unreadable rather than escaping to the caller.
function readBrowserSessionMeta(
  resolveMetadataPath: () => string,
  defaultPartition: string
): BrowserSessionMetaRead {
  let raw: string
  try {
    raw = readFileSync(resolveMetadataPath(), 'utf-8')
  } catch (err) {
    // Only a missing path proves nothing was stored; every other code means we could not look.
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { status: 'absent' }
    }
    return { status: 'unreadable', reason: describeError(err) }
  }
  let data: Record<string, unknown> | null
  try {
    data = JSON.parse(raw)
  } catch (err) {
    return { status: 'corrupt', reason: describeError(err) }
  }
  const legacyPendingCookieDbPath =
    typeof data?.pendingCookieDbPath === 'string' ? data.pendingCookieDbPath : null
  const pendingCookieImports: Record<string, string> =
    data && typeof data.pendingCookieImports === 'object' && data.pendingCookieImports
      ? { ...(data.pendingCookieImports as Record<string, string>) }
      : {}
  if (legacyPendingCookieDbPath && !pendingCookieImports[defaultPartition]) {
    pendingCookieImports[defaultPartition] = legacyPendingCookieDbPath
  }
  return {
    status: 'ok',
    meta: {
      defaultSource: (data?.defaultSource ?? null) as BrowserSessionMeta['defaultSource'],
      pendingCookieDbPath: legacyPendingCookieDbPath,
      pendingCookieImports,
      profiles: Array.isArray(data?.profiles) ? (data.profiles as BrowserSessionProfile[]) : []
    }
  }
}

export function loadBrowserSessionMeta(
  resolveMetadataPath: () => string,
  defaultPartition: string
): BrowserSessionMeta {
  const read = readBrowserSessionMeta(resolveMetadataPath, defaultPartition)
  return read.status === 'ok' ? read.meta : emptyBrowserSessionMeta()
}

// Why: write-temp-then-rename is atomic, so a crash mid-write can't corrupt the live file. The
// merge below is the other half of that promise — it may only run on a baseline we actually read.
export function persistBrowserSessionMeta(
  resolveMetadataPath: () => string,
  defaultPartition: string,
  updates: Partial<BrowserSessionMeta>
): void {
  try {
    const path = resolveMetadataPath()
    const read = readBrowserSessionMeta(resolveMetadataPath, defaultPartition)
    if (read.status === 'unreadable') {
      // Fail closed: the file is intact and momentarily locked far more often than it is gone, so
      // merging onto an empty baseline would publish an erasure of profiles we never saw.
      console.warn(`[browser-session] Skipping meta write; existing meta unreadable: ${read.reason}`)
      return
    }
    if (read.status === 'corrupt') {
      // Corrupt state never self-heals, so refusing forever would brick the feature. Rewrite, but
      // keep the bytes so the loss stays auditable instead of vanishing under the new file.
      console.warn(`[browser-session] Quarantining corrupt meta before rewrite: ${read.reason}`)
      try {
        renameSync(path, `${path}.corrupt`)
      } catch (err) {
        console.warn(`[browser-session] Corrupt meta quarantine failed: ${describeError(err)}`)
      }
    }
    const existing = read.status === 'ok' ? read.meta : emptyBrowserSessionMeta()
    const tmpPath = `${path}.tmp`
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(tmpPath, JSON.stringify({ ...existing, ...updates }))
    renameSync(tmpPath, path)
  } catch (err) {
    console.warn(`[browser-session] Failed to persist session meta: ${describeError(err)}`)
  }
}
