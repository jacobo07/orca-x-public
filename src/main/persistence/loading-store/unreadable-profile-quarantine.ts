import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs'
import { basename, dirname } from 'node:path'

// Why: bound the suffix search so a pathological directory cannot spin the startup path forever.
const MAX_QUARANTINE_ATTEMPTS = 1000

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
        writeSync(fd, bytes)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
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
    default:
      return { outcome: outcome.kind }
  }
}
