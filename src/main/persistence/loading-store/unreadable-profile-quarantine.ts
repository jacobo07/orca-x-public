import { closeSync, fsyncSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { basename, dirname } from 'node:path'

// Why: bound the suffix search so a pathological directory cannot spin the startup path forever.
export const MAX_QUARANTINE_ATTEMPTS = 1000

export type UnreadableProfileQuarantine = { ok: true; path: string } | { ok: false; code: string }

export type StartupLoadOutcome =
  | { kind: 'loaded' }
  | { kind: 'absent' }
  | {
      kind: 'recovered-from-backup'
      slot: number
      quarantinePath: string | null
      quarantineFailureCode: string | null
    }
  | { kind: 'unreadable-defaulted'; quarantinePath: string }
  | { kind: 'unreadable-unquarantined'; code: string }
  // Why: the profile parsed but a whole session part was defaulted; `loaded` would hide that bytes were set aside.
  | { kind: 'session-unreadable-defaulted'; quarantinePath: string; defaulted: string[] }
  | { kind: 'session-unreadable-unquarantined'; code: string; defaulted: string[] }
  // Why: no primary to preserve, but backups existed and none parsed, so "absent" would misname it.
  | { kind: 'backups-unusable-defaulted' }

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' ? code : 'UNKNOWN'
}

function utcStamp(now: Date): string {
  return now
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '')
}

function closeQuietly(fd: number): void {
  try {
    closeSync(fd)
  } catch {
    // The descriptor is being abandoned after a failure; the unlink that follows is what matters.
  }
}

function syncDirectoryBestEffort(directory: string): void {
  let fd: number | null = null
  try {
    fd = openSync(directory, 'r')
    fsyncSync(fd)
  } catch {
    // Why: Windows cannot open a directory for fsync; the file fsync is the load-bearing barrier.
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // Nothing actionable once the fsync was issued.
      }
    }
  }
}

/**
 * Copy the unreadable primary's bytes aside before anything can overwrite them. The create is
 * exclusive, so a second unreadable load can never replace an earlier quarantine; a failure is
 * returned, never thrown, because the load must continue exactly as it did before this existed.
 */
export function quarantineUnreadableProfile(dataFile: string): UnreadableProfileQuarantine {
  try {
    const bytes = readFileSync(dataFile)
    const base = `${dataFile}.unreadable-${utcStamp(new Date())}`
    for (let attempt = 0; attempt < MAX_QUARANTINE_ATTEMPTS; attempt++) {
      const path = attempt === 0 ? base : `${base}-${attempt}`
      let fd: number
      try {
        fd = openSync(path, 'wx')
      } catch (error) {
        if (errorCode(error) === 'EEXIST') {
          continue
        }
        return { ok: false, code: errorCode(error) }
      }
      try {
        // Why: write(2) returns a short count on a filling disk instead of throwing; a single writeSync would report a truncated copy as ok.
        let written = 0
        while (written < bytes.length) {
          const count = writeSync(fd, bytes, written, bytes.length - written)
          if (count <= 0) {
            throw Object.assign(new Error('quarantine write stalled'), { code: 'EIO' })
          }
          written += count
        }
        fsyncSync(fd)
      } catch (error) {
        closeQuietly(fd)
        // Why: only this call's exclusively-created file is removed; an earlier quarantine was never opened here.
        try {
          unlinkSync(path)
        } catch {
          // Nothing more to clean up; the failure code below is what the caller needs.
        }
        return { ok: false, code: errorCode(error) }
      }
      closeSync(fd)
      syncDirectoryBestEffort(dirname(path))
      return { ok: true, path }
    }
    return { ok: false, code: 'EEXIST' }
  } catch (error) {
    return { ok: false, code: errorCode(error) }
  }
}

/** The outcome of a load that produced no state from disk (defaults were used). */
export function defaultedStartupLoadOutcome(input: {
  primaryExisted: boolean
  backupsPresent: boolean
  quarantine: UnreadableProfileQuarantine | null
}): StartupLoadOutcome {
  if (!input.primaryExisted) {
    return input.backupsPresent ? { kind: 'backups-unusable-defaulted' } : { kind: 'absent' }
  }
  if (input.quarantine?.ok) {
    return { kind: 'unreadable-defaulted', quarantinePath: input.quarantine.path }
  }
  return {
    kind: 'unreadable-unquarantined',
    code: input.quarantine ? input.quarantine.code : 'NOT_ATTEMPTED'
  }
}

/** Per-load record of the session parts that fell to defaults, plus the one quarantine that covers them all. */
export type DefaultedSessionParts = {
  parts: string[]
  quarantine: UnreadableProfileQuarantine | null
}

export function recordDefaultedSessionPart(
  record: DefaultedSessionParts,
  part: string,
  dataFile: string
): void {
  record.parts.push(part)
  // Why: one copy of the whole original file covers every part defaulted in this load.
  record.quarantine ??= quarantineUnreadableProfile(dataFile)
}

/** The quarantine for a load that threw; reuses a session-part copy of the same file already made in this load. */
export function quarantineAfterLoadFailure(
  record: DefaultedSessionParts,
  dataFile: string
): UnreadableProfileQuarantine {
  // Why: a throw after a session part was quarantined must reuse that copy, not write a second one.
  return record.quarantine?.ok ? record.quarantine : quarantineUnreadableProfile(dataFile)
}

/** The outcome of a load that kept the profile but defaulted a session part; null when nothing was defaulted. */
export function sessionDefaultedStartupLoadOutcome(
  record: DefaultedSessionParts
): StartupLoadOutcome | null {
  if (record.parts.length === 0) {
    return null
  }
  if (record.quarantine?.ok) {
    return {
      kind: 'session-unreadable-defaulted',
      quarantinePath: record.quarantine.path,
      defaulted: record.parts
    }
  }
  return {
    kind: 'session-unreadable-unquarantined',
    code: record.quarantine ? record.quarantine.code : 'NOT_ATTEMPTED',
    defaulted: record.parts
  }
}

export function recoveredStartupLoadOutcome(
  slot: number,
  quarantine: UnreadableProfileQuarantine | null
): StartupLoadOutcome {
  return {
    kind: 'recovered-from-backup',
    slot,
    quarantinePath: quarantine?.ok ? quarantine.path : null,
    quarantineFailureCode: quarantine && !quarantine.ok ? quarantine.code : null
  }
}

// Why: partition names carry host ids, which the startup log must not carry; keep the top-level field only.
function topLevelFields(parts: string[]): string[] {
  return [...new Set(parts.map((part) => part.split('.', 1)[0]))]
}

/** Startup-log details: file names only, never the user-data directory. */
export function startupLoadOutcomeLogDetails(outcome: StartupLoadOutcome): Record<string, unknown> {
  switch (outcome.kind) {
    case 'recovered-from-backup':
      return {
        outcome: outcome.kind,
        slot: outcome.slot,
        quarantineFile: outcome.quarantinePath ? basename(outcome.quarantinePath) : null,
        quarantineFailureCode: outcome.quarantineFailureCode
      }
    case 'unreadable-defaulted':
      return { outcome: outcome.kind, quarantineFile: basename(outcome.quarantinePath) }
    case 'unreadable-unquarantined':
      return { outcome: outcome.kind, code: outcome.code }
    case 'session-unreadable-defaulted':
      return {
        outcome: outcome.kind,
        quarantineFile: basename(outcome.quarantinePath),
        defaultedFields: topLevelFields(outcome.defaulted),
        defaultedCount: outcome.defaulted.length
      }
    case 'session-unreadable-unquarantined':
      return {
        outcome: outcome.kind,
        code: outcome.code,
        defaultedFields: topLevelFields(outcome.defaulted),
        defaultedCount: outcome.defaulted.length
      }
    default:
      return { outcome: outcome.kind }
  }
}
