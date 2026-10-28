// Row 66 (phase 19): a diverged replica pair is preserved as refs, the conflict is surfaced from a
// non-mutating merge-tree, and neither side is overwritten. No branch, index or worktree is touched; the only
// writes are create-only refs under refs/orca/divergence/ and loose objects from merge-tree.
import type { ReplicaAncestry } from '../shared/workspace-replica-state'
import { gitExecFileAsync } from './git/runner'

const HOST_KEY = /^[A-Za-z0-9._-]+$/
const SHA = /^[0-9a-f]{40,64}$/
const ZERO = '0'.repeat(40)

export type DivergenceConflict = { kind: 'clean' } | { kind: 'conflicted'; paths: string[] } | { kind: 'unknown'; reason: string }

export type DivergencePreservation =
  | {
      ok: true
      refs: { local: string; remote: string }
      mergeBase: string
      conflict: DivergenceConflict
      /** True when the refs already existed at the same shas (idempotent re-run). */
      alreadyPreserved: boolean
    }
  | { ok: false; reason: 'not-diverged' | 'bad-input' | 'ref-occupied' | 'tip-missing' }

export function divergenceRefs(hostKey: string, localTip: string, remoteTip: string): { local: string; remote: string } {
  const base = `refs/orca/divergence/${hostKey}/${localTip.slice(0, 12)}-${remoteTip.slice(0, 12)}`
  return { local: `${base}/local`, remote: `${base}/remote` }
}

async function createOnly(repoPath: string, ref: string, sha: string): Promise<'created' | 'same' | 'occupied'> {
  try {
    // The zero old-value makes update-ref fail when the ref exists: it can never move an existing ref.
    await gitExecFileAsync(['update-ref', ref, sha, ZERO], { cwd: repoPath })
    return 'created'
  } catch {
    try {
      const { stdout } = await gitExecFileAsync(['rev-parse', '--verify', ref], { cwd: repoPath })
      return stdout.trim() === sha ? 'same' : 'occupied'
    } catch {
      return 'occupied'
    }
  }
}

export async function surfaceConflict(repoPath: string, localTip: string, remoteTip: string): Promise<DivergenceConflict> {
  try {
    await gitExecFileAsync(['merge-tree', '--write-tree', '--name-only', '--no-messages', localTip, remoteTip], {
      cwd: repoPath
    })
    return { kind: 'clean' }
  } catch (error) {
    // Why: merge-tree exits 1 for conflicts but still prints the result; other codes are real failures.
    const e = error as { code?: unknown; stdout?: unknown }
    if (e.code === 1 && typeof e.stdout === 'string') {
      const [, ...rest] = e.stdout.split('\n')
      const paths: string[] = []
      for (const line of rest) {
        if (line === '') {
          break
        }
        paths.push(line)
      }
      return { kind: 'conflicted', paths: [...new Set(paths)].sort() }
    }
    return { kind: 'unknown', reason: 'merge-tree-failed' }
  }
}

export async function preserveDivergence(args: {
  repoPath: string
  hostKey: string
  localTip: string
  remoteTip: string
  ancestry: ReplicaAncestry
}): Promise<DivergencePreservation> {
  const { repoPath, hostKey, localTip, remoteTip, ancestry } = args
  if (ancestry.kind !== 'diverged') {
    return { ok: false, reason: 'not-diverged' }
  }
  if (!HOST_KEY.test(hostKey) || !SHA.test(localTip) || !SHA.test(remoteTip) || localTip === remoteTip) {
    return { ok: false, reason: 'bad-input' }
  }
  for (const tip of [localTip, remoteTip]) {
    try {
      await gitExecFileAsync(['cat-file', '-e', `${tip}^{commit}`], { cwd: repoPath })
    } catch {
      return { ok: false, reason: 'tip-missing' }
    }
  }
  const refs = divergenceRefs(hostKey, localTip, remoteTip)
  const a = await createOnly(repoPath, refs.local, localTip)
  const b = await createOnly(repoPath, refs.remote, remoteTip)
  if (a === 'occupied' || b === 'occupied') {
    return { ok: false, reason: 'ref-occupied' }
  }
  const conflict = await surfaceConflict(repoPath, localTip, remoteTip)
  return {
    ok: true,
    refs,
    mergeBase: ancestry.mergeBase,
    conflict,
    alreadyPreserved: a === 'same' && b === 'same'
  }
}
