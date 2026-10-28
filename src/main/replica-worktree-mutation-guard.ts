import { realpath } from 'node:fs/promises'

export type WorktreeMutationResult<T> = { kind: 'done'; value: T } | { kind: 'busy' }

export type ReplicaWorktreeMutationGuard = {
  /** Runs fn when no other operation holds this worktree; otherwise answers busy without calling fn. */
  run<T>(path: string, fn: () => Promise<T>): Promise<WorktreeMutationResult<T>>
  /** Held keys, for tests: the guard must be empty once every operation settled. */
  activeCount(): number
}

// Why: busy, never queued; a queued second effect would run on a worktree the first already changed, with stale checks.
export function createReplicaWorktreeMutationGuard(): ReplicaWorktreeMutationGuard {
  const active = new Set<string>()
  return {
    async run(path, fn) {
      // Why: keyed by realpath so a symlink to a worktree contends with the worktree itself.
      const key = await realpath(path)
      if (active.has(key)) {
        return { kind: 'busy' }
      }
      active.add(key)
      try {
        return { kind: 'done', value: await fn() }
      } finally {
        active.delete(key)
      }
    },
    activeCount: () => active.size
  }
}
