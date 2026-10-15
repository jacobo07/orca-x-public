// Reads and describes one capsule for restore: structural checks mirror listCapsules, plus change counts and collisions.
import { capsuleRef, parseCapsuleTrailers } from '../shared/replica-capsule-plan'
import type { CapsuleGitRun } from './replica-capsule'

export type CapsuleRestoreRefusal =
  | 'invalid-capsule-argument'
  | 'invalid-mode'
  | 'not-a-git-repo'
  | 'capsule-unknown'
  | 'capsule-damaged'
  | 'base-mismatch'
  | 'operation-in-progress'
  | 'worktree-not-clean'
  | 'untracked-collision'

/** tracked = edits on top of the index, staged = index versus base, untracked = files in the untracked tree. */
export type CapsuleRestoreChanges = { tracked: number; staged: number; untracked: number }

export type CapsuleDescription = {
  ref: string
  sha: string
  base: string
  partial: boolean
  changes: CapsuleRestoreChanges
}

export type CapsuleTrees = { worktree: string; index: string; untracked: string | null }

const BASE_SHA = /^[0-9a-f]{40,64}$/

export type Loaded = CapsuleDescription & {
  hasBase: boolean
  baseTree: string
  trees: CapsuleTrees
}
export type Change = { status: string; path: string }

export class Refusal extends Error {
  constructor(
    readonly reason: CapsuleRestoreRefusal,
    detail: string
  ) {
    super(detail)
  }
}

function parseNameStatus(out: string): Change[] {
  const tokens = out.split('\0').filter((t) => t.length > 0)
  const changes: Change[] = []
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    changes.push({ status: tokens[i], path: tokens[i + 1] })
  }
  return changes
}

export async function diffTrees(
  git: CapsuleGitRun,
  cwd: string,
  a: string,
  b: string
): Promise<Change[]> {
  return parseNameStatus(
    await git(['diff-tree', '-r', '-z', '--no-renames', '--name-status', a, b], { cwd })
  )
}

// Tree ids of a capsule commit's W, I and U parts; parents are [base?, index, untracked?].
export async function readTrees(
  git: CapsuleGitRun,
  cwd: string,
  sha: string,
  hasBase: boolean
): Promise<CapsuleTrees | null> {
  const parents = (await git(['rev-list', '--parents', '-n', '1', sha], { cwd }))
    .trim()
    .split(/\s+/)
    .slice(1)
  const iCommit = parents[hasBase ? 1 : 0]
  const uCommit = parents[hasBase ? 2 : 1]
  if (!iCommit) {
    return null
  }
  const specs = [`${sha}^{tree}`, `${iCommit}^{tree}`, ...(uCommit ? [`${uCommit}^{tree}`] : [])]
  const [worktree, index, untracked] = (await git(['rev-parse', ...specs], { cwd }))
    .trim()
    .split('\n')
  return { worktree, index, untracked: untracked ?? null }
}

export async function loadCapsule(git: CapsuleGitRun, top: string, sha: string): Promise<Loaded> {
  const ref = capsuleRef(sha)
  const damaged = (detail: string): Refusal => new Refusal('capsule-damaged', `${ref}: ${detail}`)
  const resolved = await git(['rev-parse', '--verify', '-q', ref], { cwd: top }).then(
    (s) => s.trim(),
    () => ''
  )
  if (!resolved) {
    throw new Refusal('capsule-unknown', `${ref} does not exist`)
  }
  const has = (obj: string): Promise<boolean> =>
    git(['cat-file', '-e', obj], { cwd: top }).then(
      () => true,
      () => false
    )
  // The same checks as listCapsules: the ref name must be its own target and every object must be present.
  if (resolved !== sha || !(await has(`${sha}^{commit}`))) {
    throw damaged('target-missing')
  }
  const parents = (await git(['rev-list', '--parents', '-n', '1', sha], { cwd: top }))
    .trim()
    .split(/\s+/)
    .slice(1)
  let complete = await has(`${sha}^{tree}`)
  for (const p of parents) {
    complete = complete && (await has(`${p}^{commit}`)) && (await has(`${p}^{tree}`))
  }
  if (!complete) {
    throw damaged('object-missing')
  }
  const trailers = parseCapsuleTrailers(await git(['log', '-1', '--format=%B', sha], { cwd: top }))
  const base = trailers['Orca-Base']
  if (
    trailers['Orca-Capsule-Version'] !== '1' ||
    !base ||
    (base !== 'unborn' && !BASE_SHA.test(base))
  ) {
    throw damaged('not-a-capsule')
  }
  const hasBase = base !== 'unborn'
  if (hasBase && parents[0] !== base) {
    throw damaged('base-parent-mismatch')
  }
  if (parents.length < (hasBase ? 2 : 1) || parents.length > (hasBase ? 3 : 2)) {
    throw damaged('malformed-parents')
  }
  const trees = await readTrees(git, top, sha, hasBase)
  if (!trees) {
    throw damaged('malformed-parents')
  }
  const baseTree = hasBase
    ? (await git(['rev-parse', `${base}^{tree}`], { cwd: top })).trim()
    : (await git(['hash-object', '-t', 'tree', '--stdin'], { cwd: top, input: '' })).trim()
  const untrackedCount = trees.untracked
    ? (await git(['ls-tree', '-r', '-z', '--name-only', trees.untracked], { cwd: top }))
        .split('\0')
        .filter(Boolean).length
    : 0
  return {
    ref,
    sha,
    base,
    hasBase,
    baseTree,
    trees,
    partial: Number(trailers['Orca-Omitted'] ?? '0') > 0,
    changes: {
      tracked: (await diffTrees(git, top, trees.index, trees.worktree)).length,
      staged: (await diffTrees(git, top, baseTree, trees.index)).length,
      untracked: untrackedCount
    }
  }
}

// Ignored files are invisible to status, so a path the capsule would create can still land on one.
export async function findCollisions(
  git: CapsuleGitRun,
  top: string,
  toCreate: string[]
): Promise<string[]> {
  if (toCreate.length === 0) {
    return []
  }
  const ignored = (await git(['ls-files', '-o', '-i', '--exclude-standard', '-z'], { cwd: top }))
    .split('\0')
    .filter(Boolean)
  const ignoredFiles = new Set(ignored)
  const ignoredDirs = new Set<string>()
  for (const p of ignored) {
    const parts = p.split('/')
    for (let i = 1; i < parts.length; i += 1) {
      ignoredDirs.add(parts.slice(0, i).join('/'))
    }
  }
  return toCreate.filter((p) => {
    const parts = p.split('/')
    const ancestorIsFile = parts
      .slice(0, -1)
      .some((_, i) => ignoredFiles.has(parts.slice(0, i + 1).join('/')))
    return ignoredFiles.has(p) || ignoredDirs.has(p) || ancestorIsFile
  })
}

export function differingTrees(expected: CapsuleTrees, actual: CapsuleTrees): string[] {
  const differing: string[] = []
  if (expected.worktree !== actual.worktree) {
    differing.push('worktree')
  }
  if (expected.index !== actual.index) {
    differing.push('index')
  }
  if (expected.untracked !== actual.untracked) {
    differing.push('untracked')
  }
  return differing
}
