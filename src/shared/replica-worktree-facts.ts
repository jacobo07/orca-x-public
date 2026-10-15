import type { WorktreeFact } from './workspace-replica-state'

// Past this many entries the counts stop being a measurement; the cap is stated, not hidden.
export const MAX_WORKTREE_FACT_COUNT = 1000

const UNMERGED = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

/** Parses `git status --porcelain=v1 -z --untracked-files=all` output into the model's worktree fact. */
export function worktreeFactFromPorcelain(output: string): WorktreeFact {
  if (output === '') {
    return { kind: 'clean' }
  }
  if (!output.endsWith('\0')) {
    // Unterminated output is a truncated read; reading it as clean would hide changes.
    return { kind: 'unknown', reason: 'status-unparseable' }
  }
  const fields = output.slice(0, -1).split('\0')
  let staged = 0
  let unstaged = 0
  let untracked = 0
  let unmerged = 0
  let counted = 0
  let capped = false
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]
    if (field.length < 4 || field[2] !== ' ') {
      return { kind: 'unknown', reason: 'status-unparseable' }
    }
    const xy = field.slice(0, 2)
    // A rename or copy carries its origin path as the next NUL field.
    if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') {
      i++
    }
    if (counted === MAX_WORKTREE_FACT_COUNT) {
      capped = true
      break
    }
    counted++
    if (xy === '??') {
      untracked++
    } else if (UNMERGED.has(xy)) {
      unmerged++
    } else {
      if (xy[0] !== ' ') {
        staged++
      }
      if (xy[1] !== ' ') {
        unstaged++
      }
    }
  }
  return {
    kind: 'dirty',
    staged,
    unstaged,
    untracked,
    unmerged,
    ...(capped ? { countsCapped: true as const } : {})
  }
}
