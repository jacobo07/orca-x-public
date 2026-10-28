import { describe, expect, it } from 'vitest'
import { MAX_WORKTREE_FACT_COUNT, worktreeFactFromPorcelain } from './replica-worktree-facts'

const z = (...entries: string[]): string => entries.map((e) => `${e}\0`).join('')

describe('worktreeFactFromPorcelain', () => {
  it('empty output is clean', () => {
    expect(worktreeFactFromPorcelain('')).toEqual({ kind: 'clean' })
  })

  it('maps staged, unstaged, untracked and unmerged entries to the model counts', () => {
    const out = z('M  staged.ts', ' M unstaged.ts', 'MM both.ts', '?? new.ts', 'UU conflict.ts', 'AA both-added.ts')
    expect(worktreeFactFromPorcelain(out)).toEqual({
      kind: 'dirty',
      staged: 2,
      unstaged: 2,
      untracked: 1,
      unmerged: 2
    })
  })

  it('a rename entry consumes its second path field', () => {
    // The origin path would otherwise parse as a bogus entry ("ld.ts" as XY) and miscount.
    const out = z('R  new-name.ts', 'old-name.ts', '?? extra.ts')
    expect(worktreeFactFromPorcelain(out)).toEqual({
      kind: 'dirty',
      staged: 1,
      unstaged: 0,
      untracked: 1,
      unmerged: 0
    })
  })

  it('an extra untracked file changes only the untracked count', () => {
    const base = z(' M a.ts', '?? b.ts')
    const more = z(' M a.ts', '?? b.ts', '?? c.ts')
    const a = worktreeFactFromPorcelain(base)
    const b = worktreeFactFromPorcelain(more)
    expect(a).toMatchObject({ kind: 'dirty', unstaged: 1, untracked: 1 })
    expect(b).toMatchObject({ kind: 'dirty', unstaged: 1, untracked: 2 })
    expect(b).toEqual({ ...(a as object), untracked: 2 })
  })

  it('past the cap it stops counting and says so', () => {
    const many = z(...Array.from({ length: MAX_WORKTREE_FACT_COUNT + 50 }, (_, i) => `?? f${i}.ts`))
    const fact = worktreeFactFromPorcelain(many)
    expect(fact).toMatchObject({ kind: 'dirty', countsCapped: true })
    if (fact.kind === 'dirty') {
      expect(fact.untracked).toBe(MAX_WORKTREE_FACT_COUNT)
    }
    // Control: exactly at the cap is not capped.
    const exact = z(...Array.from({ length: MAX_WORKTREE_FACT_COUNT }, (_, i) => `?? f${i}.ts`))
    expect(worktreeFactFromPorcelain(exact)).not.toHaveProperty('countsCapped')
  })

  it('output that is not porcelain is unknown, never clean', () => {
    expect(worktreeFactFromPorcelain('garbage without nul')).toMatchObject({ kind: 'unknown' })
  })
})
