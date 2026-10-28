// Verify-then-fetch receive of a transferred replica bundle, and ancestry decided on the
// transferred objects. Order: bundle verify -> list-heads set equality -> fetch -> (ancestry).
// Any failure unlinks the bundle and leaves no refs/orca/replicas/* ref behind.
import { isAbsolute } from 'node:path'
import { unlink } from 'node:fs/promises'
import { gitExecFileAsync } from './git/runner'
import type { ReplicaAncestry } from '../shared/workspace-replica-state'
import { isDiskFullError, type ReplicaFailureCause } from './replica-failure-cause'

export type DeclaredHead = { ref: string; sha: string }

export type ReplicaReceiveResult =
  | { ok: true; refs: Record<string, string> }
  | {
      ok: false
      reason: 'bundle-verify-failed' | 'bundle-heads-mismatch' | 'transfer-interrupted'
      cause?: ReplicaFailureCause
    }

const HOST_KEY = /^[A-Za-z0-9._-]+$/
const SHA = /^[0-9a-f]{40,64}$/

function replicaRef(hostKey: string, ref: string): string {
  return `refs/orca/replicas/${hostKey}/${ref}`
}

function sameHeads(listed: DeclaredHead[], declared: DeclaredHead[]): boolean {
  const key = (h: DeclaredHead): string => `${h.sha} ${h.ref}`
  const a = new Set(listed.map(key))
  const b = new Set(declared.map(key))
  return a.size === b.size && [...a].every((k) => b.has(k))
}

export async function receiveReplicaBundle(args: {
  repoPath: string
  bundlePath: string
  declaredHeads: DeclaredHead[]
  hostKey: string
}): Promise<ReplicaReceiveResult> {
  const { repoPath, bundlePath, declaredHeads, hostKey } = args
  const git = (argv: string[]) => gitExecFileAsync(argv, { cwd: repoPath })
  try {
    if (
      !HOST_KEY.test(hostKey) ||
      !isAbsolute(bundlePath) ||
      declaredHeads.length === 0 ||
      declaredHeads.some((h) => !SHA.test(h.sha) || h.ref.startsWith('-') || h.ref.includes('..'))
    ) {
      return { ok: false, reason: 'bundle-verify-failed' }
    }
    try {
      await git(['bundle', 'verify', bundlePath])
    } catch {
      return { ok: false, reason: 'bundle-verify-failed' }
    }
    let listed: DeclaredHead[]
    try {
      const { stdout } = await git(['bundle', 'list-heads', bundlePath])
      listed = stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [sha, ref] = line.split(' ')
          return { sha, ref }
        })
    } catch {
      return { ok: false, reason: 'bundle-verify-failed' }
    }
    if (!sameHeads(listed, declaredHeads)) {
      return { ok: false, reason: 'bundle-heads-mismatch' }
    }
    const refspecs = declaredHeads.map((h) => `+${h.ref}:${replicaRef(hostKey, h.ref)}`)
    try {
      await git(['fetch', '--no-tags', '--quiet', bundlePath, ...refspecs])
    } catch (error) {
      // The fetch writes objects into this host's disk; only here can the local disk be the cause.
      return isDiskFullError(error)
        ? { ok: false, reason: 'transfer-interrupted', cause: 'disk-full' }
        : { ok: false, reason: 'transfer-interrupted' }
    }
    return {
      ok: true,
      refs: Object.fromEntries(declaredHeads.map((h) => [replicaRef(hostKey, h.ref), h.sha]))
    }
  } finally {
    await unlink(bundlePath).catch(() => {})
  }
}

async function exitsZero(repoPath: string, argv: string[]): Promise<boolean> {
  try {
    await gitExecFileAsync(argv, { cwd: repoPath })
    return true
  } catch {
    return false
  }
}

/** Ancestry of local tip A vs received tip B, decided on objects already in repoPath. */
export async function decideReplicaAncestry(
  repoPath: string,
  tipA: string,
  tipB: string
): Promise<ReplicaAncestry | { unknown: 'bundle-verify-failed' }> {
  if (!SHA.test(tipA) || !SHA.test(tipB)) {
    return { unknown: 'bundle-verify-failed' }
  }
  if (tipA === tipB) {
    return { kind: 'same' }
  }
  for (const t of [tipA, tipB]) {
    if (!(await exitsZero(repoPath, ['cat-file', '-e', `${t}^{commit}`]))) {
      return { unknown: 'bundle-verify-failed' }
    }
  }
  let mergeBase: string
  try {
    const { stdout } = await gitExecFileAsync(['merge-base', tipA, tipB], { cwd: repoPath })
    mergeBase = stdout.trim()
  } catch {
    return { kind: 'unrelated' }
  }
  const { stdout } = await gitExecFileAsync(
    ['rev-list', '--left-right', '--count', `${tipA}...${tipB}`],
    { cwd: repoPath }
  )
  const [aheadCount, behindCount] = stdout.trim().split(/\s+/).map(Number)
  if (aheadCount === 0) {
    return { kind: 'behind', count: behindCount }
  }
  if (behindCount === 0) {
    return { kind: 'ahead', count: aheadCount }
  }
  return { kind: 'diverged', mergeBase, aheadCount, behindCount }
}
