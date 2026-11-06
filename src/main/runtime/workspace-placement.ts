import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  canonicalRepoKey,
  lineageKeyOf,
  localRepoKey,
  workspaceRefOf,
  type WorkspacePlacement
} from '../../shared/workspace-identity'

export type GitRead = (args: string[], cwd: string) => Promise<string>
// Why `remote`: a worktree on an SSH target has a path that means nothing here, and may even exist here as another repo.
export type PlacementSubject = {
  id: string
  instanceId?: string | null
  path: string
  remote?: boolean
}
export type UnavailablePlacement = { worktreeId: string; path: string; unavailable: string }

export const REMOTE_REPO_UNSUPPORTED = 'remote_repo_unsupported'
export const PLACEMENT_DEADLINE_EXCEEDED = 'deadline_exceeded'
const STAT_BATCH = 32
// Why pinned: a user's diff settings would otherwise change the fingerprint of identical code.
const STABLE_DIFF_ARGS = [
  '-c',
  'diff.autoRefreshIndex=false',
  'diff',
  'HEAD',
  '--binary',
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '--unified=3',
  '--diff-algorithm=myers'
]

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

// Why the origin remote: it is the one name a clone on another host shares. A repository without one falls back to its
// root commit, which every clone also shares.
async function repoKeyOf(git: GitRead, path: string): Promise<string> {
  const remote = await git(['remote', 'get-url', 'origin'], path).catch(() => '')
  const key = canonicalRepoKey(remote)
  if (key) {
    return key
  }
  const roots = await git(['rev-list', '--max-parents=0', 'HEAD'], path)
  return localRepoKey(roots.trim().split(/\s+/).sort()[0] ?? '')
}

// Why size and mtime and not contents: an untracked folder can hold gigabytes, and this runs on a read. Two different
// files with the same name, size and time are not a case worth reading everything for.
async function untrackedFingerprint(git: GitRead, path: string): Promise<string> {
  const names = (await git(['ls-files', '--others', '--exclude-standard', '-z'], path))
    .split('\0')
    .filter(Boolean)
    .sort()
  const rows: string[] = []
  for (let at = 0; at < names.length; at += STAT_BATCH) {
    const batch = names.slice(at, at + STAT_BATCH).map(async (name) => {
      const file = await stat(join(path, name)).catch(() => null)
      return `${name}\0${file?.size ?? 'gone'}\0${file?.mtimeMs ?? 'gone'}`
    })
    rows.push(...(await Promise.all(batch)))
  }
  return sha256(rows.join('\n'))
}

/** Reads one worktree. Dirty work counts: the commit alone cannot tell two different states of the code apart. */
export async function readPlacement(
  subject: PlacementSubject,
  git: GitRead
): Promise<WorkspacePlacement> {
  const { path, id } = subject
  const instanceId = subject.instanceId ?? null
  // Why the fingerprints may fail alone: the worktrees with the most dirty work are the likeliest to overflow, and they
  // must not lose their identity for it.
  const [repoKey, branch, baseCommit, diff, untracked] = await Promise.all([
    repoKeyOf(git, path),
    git(['branch', '--show-current'], path),
    git(['rev-parse', 'HEAD'], path),
    git(STABLE_DIFF_ARGS, path).then(sha256, () => null),
    untrackedFingerprint(git, path).catch(() => null)
  ])
  const lineageKey = lineageKeyOf(branch.trim() || null, instanceId, id)
  return {
    workspaceRef: workspaceRefOf(repoKey, lineageKey),
    repoKey,
    lineageKey,
    worktreeId: id,
    instanceId,
    path,
    sourceRevision: {
      baseCommit: baseCommit.trim(),
      trackedDiffFingerprint: diff,
      untrackedFingerprint: untracked
    }
  }
}

/** A worktree that cannot be read is reported, never dropped: a silent gap would look like a host without that work. */
export async function readPlacements(
  subjects: PlacementSubject[],
  git: GitRead,
  deadlineAtMs = Number.POSITIVE_INFINITY,
  now: () => number = Date.now
): Promise<{ placements: WorkspacePlacement[]; unavailable: UnavailablePlacement[] }> {
  const placements: WorkspacePlacement[] = []
  const unavailable: UnavailablePlacement[] = []
  for (const subject of subjects) {
    const refused = subject.remote
      ? REMOTE_REPO_UNSUPPORTED
      : now() >= deadlineAtMs
        ? PLACEMENT_DEADLINE_EXCEEDED
        : null
    if (refused) {
      unavailable.push({ worktreeId: subject.id, path: subject.path, unavailable: refused })
      continue
    }
    try {
      placements.push(await readPlacement(subject, git))
    } catch (error) {
      unavailable.push({
        worktreeId: subject.id,
        path: subject.path,
        unavailable: error instanceof Error ? error.message : String(error)
      })
    }
  }
  return { placements, unavailable }
}
