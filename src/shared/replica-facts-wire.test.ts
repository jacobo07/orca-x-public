import { describe, expect, it } from 'vitest'
import { parseReplicaFactsWire } from './replica-facts-wire'
import type { WorktreeFact } from './workspace-replica-state'

const DIRTY = { kind: 'dirty', staged: 1, unstaged: 2, untracked: 3, unmerged: 0 } as const

describe('parseReplicaFactsWire', () => {
  it.each<WorktreeFact>([
    { kind: 'clean' },
    DIRTY,
    { ...DIRTY, countsCapped: true },
    { kind: 'unknown', reason: 'not-a-git-repo' }
  ])('accepts and round-trips %j', (worktree) => {
    expect(parseReplicaFactsWire({ worktree })).toEqual({ ok: true, worktree })
  })

  it('ignores unknown extra keys so a newer relay may add an optional field', () => {
    expect(parseReplicaFactsWire({ worktree: { kind: 'clean', extra: 1 }, more: true })).toEqual({
      ok: true,
      worktree: { kind: 'clean' }
    })
  })

  it.each([
    ['null', null],
    ['array', []],
    ['string', 'clean'],
    ['missing worktree', {}],
    ['worktree as string', { worktree: 'clean' }],
    ['worktree as array', { worktree: [] }],
    ['unknown kind', { worktree: { kind: 'pristine' } }],
    ['negative count', { worktree: { ...DIRTY, staged: -1 } }],
    ['fractional count', { worktree: { ...DIRTY, unstaged: 1.5 } }],
    ['unsafe integer', { worktree: { ...DIRTY, untracked: Number.MAX_SAFE_INTEGER + 1 } }],
    ['string count', { worktree: { ...DIRTY, unmerged: '0' } }],
    ['missing count', { worktree: { kind: 'dirty', staged: 0, unstaged: 0, untracked: 0 } }],
    ['countsCapped false', { worktree: { ...DIRTY, countsCapped: false } }],
    ['empty reason', { worktree: { kind: 'unknown', reason: '' } }],
    ['non-string reason', { worktree: { kind: 'unknown', reason: 7 } }],
    ['over-long reason', { worktree: { kind: 'unknown', reason: 'x'.repeat(201) } }]
  ])('rejects %s', (_name, value) => {
    expect(parseReplicaFactsWire(value)).toMatchObject({ ok: false })
  })

  it('accepts a reason at the length limit (control for the over-long rejection)', () => {
    const reason = 'x'.repeat(200)
    expect(parseReplicaFactsWire({ worktree: { kind: 'unknown', reason } })).toEqual({
      ok: true,
      worktree: { kind: 'unknown', reason }
    })
  })

  it('accepts a dirty fact with zero counts (control for the negative-count rejection)', () => {
    const worktree = { kind: 'dirty', staged: 0, unstaged: 0, untracked: 0, unmerged: 0 }
    expect(parseReplicaFactsWire({ worktree })).toEqual({ ok: true, worktree })
  })
})
