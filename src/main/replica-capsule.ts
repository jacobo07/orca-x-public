// Dirty-state capsule (phase 17, D-17..D-23): a stash-shaped commit (W; parents HEAD, I[, U]) built from temp-index
// trees and published by ONE create-only ref update under refs/orca/capsules/. Never writes the real index, HEAD,
// refs/heads/*, refs/stash or the worktree. The git runner is injected so main and tests/e2e share this code.
import { randomUUID } from 'node:crypto'
import { copyFile, lstat, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CAPSULE_IDENTITY,
  CAPSULE_MAX_FILE_BYTES,
  CAPSULE_MAX_UNTRACKED_BYTES,
  buildCapsuleMessage,
  capsuleRef,
  isSecretShapedPath,
  parseCapsuleTrailers,
  CAPSULE_REF_PREFIX,
  type CapsuleOmission
} from '../shared/replica-capsule-plan'

export type CapsuleGitRun = (
  argv: string[],
  options: { cwd: string; env?: Record<string, string>; input?: string }
) => Promise<string>

export type CapsuleResult =
  | { kind: 'clean' }
  | { kind: 'refused'; reason: 'capsule-unmerged' | 'capsule-unstable' | 'not-a-git-repo' }
  | {
      kind: 'created'
      ref: string
      sha: string
      base: string
      alreadyExisted: boolean
      omissions: CapsuleOmission[]
      partial: boolean
    }

export type CapsuleFact =
  | { ref: string; sha: string; baseTip: string; partial: boolean }
  | { ref: string; damaged: true; reason: string }

const FSYNC = ['-c', 'core.fsyncObjectFiles=true', '-c', 'core.fsync=objects,reference']
const TEMP_PREFIX = 'orca-capsule-index-'
const IN_PROGRESS = [
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'REBASE_HEAD',
  'rebase-merge',
  'rebase-apply'
]
const activeGitDirs = new Set<string>()

type Built = {
  head: string
  branch: string
  status: string
  iTree: string
  wTree: string
  uTree: string | null
  omissions: CapsuleOmission[]
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  )
}

async function sweepStaleTemps(gitDir: string, startedAt: number): Promise<void> {
  if (activeGitDirs.has(gitDir)) {
    return
  }
  for (const name of await readdir(gitDir).catch(() => [] as string[])) {
    if (!name.startsWith(TEMP_PREFIX)) {
      continue
    }
    const full = join(gitDir, name)
    const s = await stat(full).catch(() => null)
    if (s && s.isFile() && s.mtimeMs < startedAt) {
      await unlink(full).catch(() => {})
    }
  }
}

async function build(
  git: CapsuleGitRun,
  top: string,
  gitDir: string,
  head: string
): Promise<Built> {
  const status = await git(['status', '--porcelain=v2', '-z', '-uall'], { cwd: top })
  const branch = await git(['symbolic-ref', '-q', 'HEAD'], { cwd: top }).then(
    (s) => s.trim() || 'detached',
    () => 'detached'
  )
  const temps = [join(gitDir, `${TEMP_PREFIX}${randomUUID()}`), join(gitDir, `${TEMP_PREFIX}${randomUUID()}`)]
  try {
    const realIndex = join(gitDir, 'index')
    const env = { GIT_INDEX_FILE: temps[0] }
    if (await exists(realIndex)) {
      await copyFile(realIndex, temps[0])
    } else if (head !== 'unborn') {
      await git(['read-tree', head], { cwd: top, env })
    }
    const iTree = (await git([...FSYNC, 'write-tree'], { cwd: top, env })).trim()
    await git([...FSYNC, 'add', '-u'], { cwd: top, env })
    const wTree = (await git([...FSYNC, 'write-tree'], { cwd: top, env })).trim()

    const listed = (await git(['ls-files', '-o', '--exclude-standard', '-z'], { cwd: top }))
      .split('\0')
      .filter(Boolean)
    const omissions: CapsuleOmission[] = []
    const kept: string[] = []
    let total = 0
    for (const p of listed.sort()) {
      if (p.endsWith('/')) {
        omissions.push({ reason: 'nested-repo', path: p })
      } else if (isSecretShapedPath(p)) {
        omissions.push({ reason: 'secret-shaped', path: p })
      } else {
        const s = await lstat(join(top, p)).catch(() => null)
        if (!s) {
          omissions.push({ reason: 'unreadable', path: p })
        } else if (s.size > CAPSULE_MAX_FILE_BYTES) {
          omissions.push({ reason: 'too-large', path: p })
        } else if (total + s.size > CAPSULE_MAX_UNTRACKED_BYTES) {
          omissions.push({ reason: 'budget-exceeded', path: p })
        } else {
          total += s.size
          kept.push(p)
        }
      }
    }
    let uTree: string | null = null
    if (kept.length > 0) {
      const uenv = { GIT_INDEX_FILE: temps[1] }
      await git([...FSYNC, 'update-index', '--add', '-z', '--stdin'], {
        cwd: top,
        env: uenv,
        input: `${kept.join('\0')}\0`
      })
      uTree = (await git([...FSYNC, 'write-tree'], { cwd: top, env: uenv })).trim()
    }
    return { head, branch, status, iTree, wTree, uTree, omissions }
  } finally {
    for (const t of temps) {
      await unlink(t).catch(() => {})
    }
  }
}

function sameBuild(a: Built, b: Built): boolean {
  return (
    a.head === b.head &&
    a.status === b.status &&
    a.iTree === b.iTree &&
    a.wTree === b.wTree &&
    a.uTree === b.uTree &&
    JSON.stringify(a.omissions) === JSON.stringify(b.omissions)
  )
}

export async function createCapsule(git: CapsuleGitRun, worktreePath: string): Promise<CapsuleResult> {
  const startedAt = Date.now()
  let top: string
  let gitDir: string
  try {
    top = (await git(['rev-parse', '--show-toplevel'], { cwd: worktreePath })).trim()
    gitDir = (await git(['rev-parse', '--absolute-git-dir'], { cwd: worktreePath })).trim()
  } catch {
    return { kind: 'refused', reason: 'not-a-git-repo' }
  }
  const head = await git(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { cwd: top }).then(
    (s) => s.trim(),
    () => 'unborn'
  )
  const probe = await git(['status', '--porcelain=v2', '-z', '-uall'], { cwd: top })
  if (probe.length === 0) {
    return { kind: 'clean' }
  }
  const inProgress = (await Promise.all(IN_PROGRESS.map((n) => exists(join(gitDir, n))))).some(Boolean)
  if (inProgress || probe.split('\0').some((e) => e.startsWith('u '))) {
    return { kind: 'refused', reason: 'capsule-unmerged' }
  }
  if (activeGitDirs.has(gitDir)) {
    return { kind: 'refused', reason: 'capsule-unstable' }
  }
  await sweepStaleTemps(gitDir, startedAt).catch(() => {})
  activeGitDirs.add(gitDir)
  try {
    const first = await build(git, top, gitDir, head)
    // Fence: a second build must be identical, else the worktree moved under us (no ref is written).
    const headNow = await git(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { cwd: top }).then(
      (s) => s.trim(),
      () => 'unborn'
    )
    const second = await build(git, top, gitDir, headNow)
    if (!sameBuild(first, second)) {
      return { kind: 'refused', reason: 'capsule-unstable' }
    }

    const date = head === 'unborn' ? '@1 +0000' : `@${(await git(['log', '-1', '--format=%ct', head], { cwd: top })).trim()} +0000`
    const env = {
      GIT_AUTHOR_NAME: CAPSULE_IDENTITY.name,
      GIT_AUTHOR_EMAIL: CAPSULE_IDENTITY.email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: CAPSULE_IDENTITY.name,
      GIT_COMMITTER_EMAIL: CAPSULE_IDENTITY.email,
      GIT_COMMITTER_DATE: date
    }
    const parents = head === 'unborn' ? [] : ['-p', head]
    const commit = async (tree: string, ps: string[], message: string): Promise<string> =>
      (
        await git([...FSYNC, 'commit-tree', tree, ...ps, '-F', '-'], { cwd: top, env, input: message })
      ).trim()
    const iSha = await commit(first.iTree, parents, 'orca capsule index\n')
    const uSha = first.uTree ? await commit(first.uTree, [], 'orca capsule untracked\n') : null
    const wSha = await commit(
      first.wTree,
      [...parents, '-p', iSha, ...(uSha ? ['-p', uSha] : [])],
      buildCapsuleMessage({ base: head, branch: first.branch, omissions: first.omissions })
    )

    const ref = capsuleRef(wSha)
    let alreadyExisted = false
    try {
      await git([...FSYNC, 'update-ref', ref, wSha, '0'.repeat(wSha.length)], { cwd: top })
    } catch (error) {
      const cur = await git(['rev-parse', '--verify', '-q', ref], { cwd: top }).then(
        (s) => s.trim(),
        () => ''
      )
      if (cur !== wSha) {
        throw error
      }
      alreadyExisted = true
    }
    return {
      kind: 'created',
      ref,
      sha: wSha,
      base: head,
      alreadyExisted,
      omissions: first.omissions,
      partial: first.omissions.length > 0
    }
  } finally {
    activeGitDirs.delete(gitDir)
  }
}

export async function listCapsules(git: CapsuleGitRun, worktreePath: string): Promise<CapsuleFact[]> {
  const out = await git(
    ['for-each-ref', '--format=%(refname) %(objectname)', CAPSULE_REF_PREFIX.slice(0, -1)],
    { cwd: worktreePath }
  )
  const facts: CapsuleFact[] = []
  for (const line of out.split('\n').filter(Boolean)) {
    const [ref, sha] = line.split(' ')
    const damaged = (reason: string): CapsuleFact => ({ ref, damaged: true, reason })
    try {
      const ok = (obj: string): Promise<boolean> =>
        git(['cat-file', '-e', obj], { cwd: worktreePath }).then(
          () => true,
          () => false
        )
      if (ref !== capsuleRef(sha) || !(await ok(`${sha}^{commit}`))) {
        facts.push(damaged('target-missing'))
        continue
      }
      const parents = (await git(['rev-list', '--parents', '-n', '1', sha], { cwd: worktreePath }))
        .trim()
        .split(' ')
        .slice(1)
      let complete = await ok(`${sha}^{tree}`)
      for (const p of parents) {
        complete = complete && (await ok(`${p}^{commit}`)) && (await ok(`${p}^{tree}`))
      }
      if (!complete) {
        facts.push(damaged('object-missing'))
        continue
      }
      const message = await git(['log', '-1', '--format=%B', sha], { cwd: worktreePath })
      const t = parseCapsuleTrailers(message)
      if (t['Orca-Capsule-Version'] !== '1' || !t['Orca-Base']) {
        facts.push(damaged('not-a-capsule'))
        continue
      }
      facts.push({ ref, sha, baseTip: t['Orca-Base'], partial: Number(t['Orca-Omitted'] ?? '0') > 0 })
    } catch {
      facts.push(damaged('unreadable'))
    }
  }
  return facts
}
