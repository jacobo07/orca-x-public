import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { RalphMissionRecord } from '../../shared/mission-brief-types'

/**
 * Ralph long-run mission records (`~/.claude/state/gsd-mission-<id>.json`), filtered to one
 * workspace. Read-only: the mission runner owns these files and the brief only reports them.
 */

const RECORD = /^gsd-mission-m-[0-9a-f]+\.json$/

export function defaultRalphStateDir(): string {
  return path.join(homedir(), '.claude', 'state')
}

export function samePath(
  a: string,
  b: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const norm = (p: string): string => {
    const resolved = path.resolve(p).replace(/[\\/]+$/, '')
    return platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return norm(a) === norm(b)
}

function secondsToMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1000) : null
}

export function parseRalphRecord(raw: unknown): (RalphMissionRecord & { cwd: string }) | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const record = raw as Record<string, unknown>
  const cwd = typeof record.work_dir === 'string' ? record.work_dir : record.cwd
  if (
    typeof record.mission_id !== 'string' ||
    typeof record.state !== 'string' ||
    typeof cwd !== 'string'
  ) {
    return null
  }
  const owner =
    record.owner && typeof record.owner === 'object'
      ? (record.owner as Record<string, unknown>)
      : null
  return {
    cwd,
    missionId: record.mission_id,
    state: record.state,
    reason: typeof record.reason === 'string' ? record.reason : '',
    workstream:
      typeof record.workstream === 'string' && record.workstream ? record.workstream : null,
    heartbeatAtMs: secondsToMs(owner?.heartbeat_at),
    updatedAtMs: secondsToMs(record.updated_at)
  }
}

/** Latest record first. An unreadable directory yields `[]`: no record is not a claim of idleness. */
export async function readRalphMissionsFor(
  workspacePath: string,
  stateDir: string = defaultRalphStateDir()
): Promise<RalphMissionRecord[]> {
  let names: string[]
  try {
    names = (await readdir(stateDir)).filter((name) => RECORD.test(name))
  } catch {
    return []
  }
  const records: RalphMissionRecord[] = []
  for (const name of names) {
    try {
      const parsed = parseRalphRecord(JSON.parse(await readFile(path.join(stateDir, name), 'utf8')))
      if (parsed && samePath(parsed.cwd, workspacePath)) {
        const { cwd: _cwd, ...record } = parsed
        records.push(record)
      }
    } catch {
      // Why skip: a record the runner is rewriting mid-read is simply not counted this read.
    }
  }
  return records.sort((a, b) => (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0))
}
