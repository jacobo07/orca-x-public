import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { GitHeadReading, PlanningFilesReading } from '../../shared/mission-brief-types'
import { gitExecFileAsync } from '../git/runner'

/** The filesystem and git reads behind a Mission Brief. All read-only. */

// Why depth 5: `.planning` children are depth 1, so `workstreams/<ws>/phases/<nn>/` is depth 5 — where verification files land.
const PLANNING_WALK_DEPTH = 5
// Why a bound: past it the walk costs more than the read it saves, so the brief is simply not cached.
const PLANNING_WALK_MAX_ENTRIES = 4000

export async function listDirs(dir: string): Promise<string[] | null> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return null
  }
}

export async function fileExists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}

export async function readGitHead(
  cwd: string,
  recordedHead: string | null
): Promise<GitHeadReading> {
  let head: string
  try {
    head = (await gitExecFileAsync(['rev-parse', 'HEAD'], { cwd, timeout: 15_000 })).stdout.trim()
  } catch {
    return { kind: 'unreadable' }
  }
  if (!/^[0-9a-f]{40,64}$/.test(head)) {
    return { kind: 'unreadable' }
  }
  if (!recordedHead || recordedHead === head || !/^[0-9a-f]{7,64}$/.test(recordedHead)) {
    return { kind: 'read', head, commitsSinceRecorded: recordedHead === head ? 0 : null }
  }
  try {
    const count = (
      await gitExecFileAsync(['rev-list', '--count', `${recordedHead}..HEAD`], {
        cwd,
        timeout: 15_000
      })
    ).stdout.trim()
    return { kind: 'read', head, commitsSinceRecorded: /^\d+$/.test(count) ? Number(count) : null }
  } catch {
    // Why null: the recorded commit may be unreachable here (rebased, other clone); count unknown.
    return { kind: 'read', head, commitsSinceRecorded: null }
  }
}

export async function listPlanningFiles(
  planningDir: string,
  workspacePath: string
): Promise<PlanningFilesReading> {
  const files: string[] = []
  let entries = 0
  let truncated = false
  const walk = async (dir: string, depth: number): Promise<boolean> => {
    let children: Dirent[]
    try {
      children = await readdir(dir, { withFileTypes: true })
    } catch {
      truncated = true
      return false
    }
    for (const child of children) {
      if (++entries > PLANNING_WALK_MAX_ENTRIES) {
        truncated = true
        return true
      }
      const full = path.join(dir, child.name)
      if (child.isFile()) {
        files.push(path.relative(workspacePath, full).split(path.sep).join('/'))
      } else if (child.isDirectory()) {
        if (depth >= PLANNING_WALK_DEPTH) {
          truncated = true
        } else {
          await walk(full, depth + 1)
        }
      }
    }
    return true
  }
  if (!(await walk(planningDir, 1))) {
    return { kind: 'unreadable' }
  }
  return { kind: 'listed', files: files.sort(), truncated }
}

export async function planningFingerprint(
  planningDir: string,
  cwd: string
): Promise<string | null> {
  let entries = 0
  let newest = 0
  const walk = async (dir: string, depth: number): Promise<boolean> => {
    let children: Dirent[]
    try {
      children = await readdir(dir, { withFileTypes: true })
    } catch {
      return false
    }
    for (const child of children) {
      entries++
      if (entries > PLANNING_WALK_MAX_ENTRIES) {
        return false
      }
      const full = path.join(dir, child.name)
      try {
        newest = Math.max(newest, (await stat(full)).mtimeMs)
      } catch {
        return false
      }
      if (child.isDirectory() && depth < PLANNING_WALK_DEPTH && !(await walk(full, depth + 1))) {
        return false
      }
    }
    return true
  }
  if (!(await walk(planningDir, 1))) {
    return null
  }
  const git = await readGitHead(cwd, null)
  return git.kind === 'read' ? `${git.head}:${entries}:${newest}` : null
}
