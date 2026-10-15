// Capsule restore (row 64): plan by default, apply only onto a clean worktree at the capsule's base, then prove it.
// Capsule refs only: no stash, no reset --hard, no clean, no whole-tree force checkout; the shared stash stack is never touched.
import { randomUUID } from 'node:crypto'
import { rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { capsuleRef } from '../shared/replica-capsule-plan'
import { createCapsule, type CapsuleGitRun } from './replica-capsule'
import {
  Refusal,
  diffTrees,
  differingTrees,
  findCollisions,
  loadCapsule,
  readTrees,
  type CapsuleDescription,
  type CapsuleRestoreChanges,
  type CapsuleRestoreRefusal,
  type CapsuleTrees,
  type Loaded
} from './replica-capsule-inspection'

export type { CapsuleRestoreChanges, CapsuleRestoreRefusal }

export type CapsuleRestoreMode = 'plan' | 'apply'

export type CapsuleRestoreResult =
  | { kind: 'refused'; reason: CapsuleRestoreRefusal; detail: string }
  | ({ kind: 'plan' } & CapsuleDescription)
  | ({
      kind: 'applied'
      verified: CapsuleTrees
      /** Set when the proving re-capture published a ref of its own (a partial capsule re-captures to a different commit). */
      recaptureRef?: string
      /** Temporary index files that could not be removed; the capsule sweeper reclaims them later. */
      warnings: string[]
    } & CapsuleDescription)
  | {
      kind: 'failed'
      reason: 'apply-failed' | 'verify-failed'
      ref: string
      detail: string
      recovery: string
    }

// Same prefix as replica-capsule.ts so its stale-temp sweep reclaims anything a crash leaves behind.
const TEMP_PREFIX = 'orca-capsule-index-'
const IN_PROGRESS = [
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'REBASE_HEAD',
  'rebase-merge',
  'rebase-apply'
]
const CAPSULE_ARGUMENT = /^(?:refs\/orca\/capsules\/)?([0-9a-f]{40,64})$/
const RM_CHUNK = 100

const refused = (reason: CapsuleRestoreRefusal, detail: string): CapsuleRestoreResult => ({
  kind: 'refused',
  reason,
  detail
})

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  )
}

async function resolveHead(git: CapsuleGitRun, cwd: string): Promise<string> {
  return git(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { cwd }).then(
    (s) => s.trim(),
    () => 'unborn'
  )
}

const worktreeStatus = (git: CapsuleGitRun, cwd: string): Promise<string> =>
  git(['--no-optional-locks', 'status', '--porcelain=v2', '-z', '-uall'], { cwd })

export async function restoreCapsule(args: {
  git: CapsuleGitRun
  worktreePath: string
  /** Full capsule sha, or exactly refs/orca/capsules/<sha>. */
  capsule: string
  mode?: CapsuleRestoreMode
}): Promise<CapsuleRestoreResult> {
  const { git, worktreePath } = args
  const mode = args.mode ?? 'plan'
  const matched = typeof args.capsule === 'string' ? CAPSULE_ARGUMENT.exec(args.capsule) : null
  if (!matched) {
    return refused(
      'invalid-capsule-argument',
      'capsule must be a full sha or refs/orca/capsules/<sha>'
    )
  }
  if (mode !== 'plan' && mode !== 'apply') {
    return refused('invalid-mode', 'mode must be plan or apply')
  }
  let top: string
  let gitDir: string
  try {
    top = (await git(['rev-parse', '--show-toplevel'], { cwd: worktreePath })).trim()
    gitDir = (await git(['rev-parse', '--absolute-git-dir'], { cwd: worktreePath })).trim()
  } catch {
    return refused('not-a-git-repo', `${worktreePath} is not a git worktree`)
  }

  let loaded: Loaded
  const checked = async (): Promise<CapsuleRestoreResult | null> => {
    const head = await resolveHead(git, top)
    if (head !== loaded.base) {
      return refused('base-mismatch', `worktree HEAD is ${head}, capsule base is ${loaded.base}`)
    }
    if ((await Promise.all(IN_PROGRESS.map((n) => exists(join(gitDir, n))))).some(Boolean)) {
      return refused(
        'operation-in-progress',
        'a merge, rebase, cherry-pick or revert is in progress'
      )
    }
    if ((await worktreeStatus(git, top)).length > 0) {
      return refused('worktree-not-clean', 'restore needs a clean worktree at the capsule base')
    }
    return null
  }
  try {
    loaded = await loadCapsule(git, top, matched[1])
  } catch (error) {
    if (error instanceof Refusal) {
      return refused(error.reason, error.message)
    }
    return refused(
      'capsule-damaged',
      `${capsuleRef(matched[1])}: unreadable (${error instanceof Error ? error.message : String(error)})`
    )
  }
  const early = await checked()
  if (early) {
    return early
  }

  const wChanges = await diffTrees(git, top, loaded.baseTree, loaded.trees.worktree)
  const untrackedPaths = loaded.trees.untracked
    ? (await git(['ls-tree', '-r', '-z', '--name-only', loaded.trees.untracked], { cwd: top }))
        .split('\0')
        .filter(Boolean)
    : []
  const collisions = await findCollisions(git, top, [
    ...wChanges.filter((c) => c.status === 'A').map((c) => c.path),
    ...untrackedPaths
  ])
  if (collisions.length > 0) {
    return refused(
      'untracked-collision',
      `an ignored file already exists at: ${collisions.slice(0, 5).join(', ')}`
    )
  }

  const description: CapsuleDescription = {
    ref: loaded.ref,
    sha: loaded.sha,
    base: loaded.base,
    partial: loaded.partial,
    changes: loaded.changes
  }
  if (mode === 'plan') {
    return { kind: 'plan', ...description }
  }

  // Second fence: a move between the first checks and the first write must not be written over.
  const moved = await checked()
  if (moved) {
    return moved
  }

  const temps: string[] = []
  const tempIndex = (): string => {
    const path = join(gitDir, `${TEMP_PREFIX}${randomUUID()}`)
    temps.push(path)
    return path
  }
  const failed = (
    reason: 'apply-failed' | 'verify-failed',
    detail: string
  ): CapsuleRestoreResult => ({
    kind: 'failed',
    reason,
    ref: loaded.ref,
    detail,
    recovery: `Capsule ${loaded.ref} is intact; nothing was rolled back or deleted. Inspect git status in ${top}, and read any file from the capsule with git show ${loaded.sha}:<path> (untracked files are under ${loaded.sha}^3).`
  })
  const warnings: string[] = []
  try {
    const deleted = wChanges.filter((c) => c.status === 'D').map((c) => c.path)
    if (deleted.length > 0) {
      // A scratch index holding the base tree keeps the real index untouched while git removes the worktree files.
      const baseIndex = tempIndex()
      await git(['read-tree', loaded.baseTree], { cwd: top, env: { GIT_INDEX_FILE: baseIndex } })
      for (let i = 0; i < deleted.length; i += RM_CHUNK) {
        await git(
          ['--literal-pathspecs', 'rm', '-q', '-f', '--', ...deleted.slice(i, i + RM_CHUNK)],
          {
            cwd: top,
            env: { GIT_INDEX_FILE: baseIndex }
          }
        )
      }
    }
    const written = wChanges.filter((c) => c.status !== 'D')
    if (written.length > 0) {
      const wIndex = tempIndex()
      await git(['read-tree', loaded.trees.worktree], { cwd: top, env: { GIT_INDEX_FILE: wIndex } })
      const overwrite = written.filter((c) => c.status !== 'A').map((c) => c.path)
      const create = written.filter((c) => c.status === 'A').map((c) => c.path)
      // Tracked paths are clean at the base, so only they may be overwritten; new paths never overwrite.
      if (overwrite.length > 0) {
        await git(['checkout-index', '-q', '-f', '-z', '--stdin'], {
          cwd: top,
          env: { GIT_INDEX_FILE: wIndex },
          input: `${overwrite.join('\0')}\0`
        })
      }
      if (create.length > 0) {
        await git(['checkout-index', '-q', '-z', '--stdin'], {
          cwd: top,
          env: { GIT_INDEX_FILE: wIndex },
          input: `${create.join('\0')}\0`
        })
      }
    }
    await git(['read-tree', loaded.trees.index], { cwd: top })
    if (loaded.trees.untracked) {
      const uIndex = tempIndex()
      await git(['read-tree', loaded.trees.untracked], {
        cwd: top,
        env: { GIT_INDEX_FILE: uIndex }
      })
      await git(['checkout-index', '-q', '-a'], { cwd: top, env: { GIT_INDEX_FILE: uIndex } })
    }
  } catch (error) {
    return failed('apply-failed', error instanceof Error ? error.message : String(error))
  } finally {
    for (const path of temps) {
      await rm(path, { force: true }).catch(() => warnings.push(path))
    }
  }

  let detail: string | null = null
  let recaptureRef: string | undefined
  try {
    const again = await createCapsule(git, top)
    if (again.kind === 'refused') {
      detail = `re-capture refused: ${again.reason}`
    } else {
      const actual: CapsuleTrees | null =
        again.kind === 'created'
          ? await readTrees(git, top, again.sha, again.base !== 'unborn')
          : { worktree: loaded.baseTree, index: loaded.baseTree, untracked: null }
      const differing = actual ? differingTrees(loaded.trees, actual) : ['unreadable']
      if (differing.length > 0) {
        detail = `re-capture differs in: ${differing.join(', ')}`
      }
      if (again.kind === 'created' && again.sha !== loaded.sha) {
        recaptureRef = again.ref
      }
    }
  } catch (error) {
    detail = `re-capture failed: ${error instanceof Error ? error.message : String(error)}`
  }
  if (detail) {
    return failed('verify-failed', detail)
  }
  return { kind: 'applied', ...description, verified: loaded.trees, recaptureRef, warnings }
}
