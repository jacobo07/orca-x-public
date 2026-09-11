import { describe, expect, it, vi } from 'vitest'
import { DiscardObservedStateRequiredError } from '../../../../../../shared/stale-worktree-state'
import { runDiscardAllForArea, type DiscardAllDeps } from './discard-all-sequence'

/**
 * What the bulk sequence does with a host that refused, and what it claims afterwards.
 *
 * Two defects live here and they compound. The bulk branch caught EVERY rejection and replayed the same
 * paths through the per-file loop -- written for older relays that lack the bulk method, which is a real
 * case, but the catch cannot tell that case from a host refusing to destroy newer work. The moment a
 * refusal became possible, that line turned "your file moved, nothing was destroyed" into "destroy it one
 * file at a time". A fail-open fallback is worse than no protection, because the user was told they were
 * protected.
 *
 * And on success the branch returned every requested path as discarded, which the host never said. Once
 * the host can keep a member back, that is a false aggregate: nineteen destroyed and one kept reads as
 * twenty destroyed, so the survivor looks like a bug rather than the protection working.
 */

function deps(overrides: Partial<DiscardAllDeps> = {}): DiscardAllDeps & {
  discardOneCalls: string[]
} {
  const discardOneCalls: string[] = []
  return {
    bulkUnstage: vi.fn(async () => {}),
    discardOne: vi.fn(async (filePath: string) => {
      discardOneCalls.push(filePath)
    }),
    discardOneCalls,
    ...overrides
  }
}

describe('a bulk discard whose host kept a member back', () => {
  it('does not replay the refused paths through the per-file loop', async () => {
    const base = deps()
    const discardMany = vi.fn(async () => ({ discarded: ['a.ts'], refused: ['b.ts'] }))

    const result = await runDiscardAllForArea('unstaged', ['a.ts', 'b.ts'], {
      ...base,
      discardMany
    })

    expect(base.discardOneCalls).toEqual([])
    expect(result.discarded).toEqual(['a.ts'])
    expect(result.refused).toEqual(['b.ts'])
    expect(result.failed).toEqual([])
  })

  it('reports only what the host actually discarded', async () => {
    // The aggregate must not invent. Saying "2 discarded" when one survived makes the survivor look like
    // a defect instead of the protection doing its job.
    const base = deps()
    const discardMany = vi.fn(async () => ({ discarded: ['a.ts'], refused: ['b.ts'] }))

    const result = await runDiscardAllForArea('unstaged', ['a.ts', 'b.ts'], {
      ...base,
      discardMany
    })

    expect(result.discarded).not.toContain('b.ts')
  })

  it('does not fall back when the bulk call was refused rather than unavailable', async () => {
    // A host that rejects with a refusal has already answered. Falling back here would ask a second
    // time, and on a host where the per-file path is the unprotected one it would destroy the file.
    const base = deps()
    const discardMany = vi.fn(async () => {
      throw new DiscardObservedStateRequiredError('b.ts')
    })

    const result = await runDiscardAllForArea('unstaged', ['a.ts', 'b.ts'], {
      ...base,
      discardMany
    })

    expect(base.discardOneCalls).toEqual([])
    expect(result.discarded).toEqual([])
    expect(result.failed.sort()).toEqual(['a.ts', 'b.ts'])
  })

  it('still falls back per file when the host has no bulk method at all', async () => {
    // The case the catch was written for, and it must keep working: an older relay that never learned the
    // bulk request. The per-file path it falls back to is itself protected now, so this is not a downgrade.
    const base = deps()
    const discardMany = vi.fn(async () => {
      throw new Error('unknown method: git.bulkDiscard')
    })

    const result = await runDiscardAllForArea('unstaged', ['a.ts', 'b.ts'], {
      ...base,
      discardMany
    })

    expect(base.discardOneCalls).toEqual(['a.ts', 'b.ts'])
    expect(result.discarded).toEqual(['a.ts', 'b.ts'])
    expect(result.refused).toEqual([])
  })

  it('separates a per-file refusal from a per-file failure in the fallback', async () => {
    // Both leave the file alone and only one is a problem. Collapsing them would report a conflict as an
    // error, which sends the user hunting for a fault instead of at their own newer work.
    const base = deps({
      discardOne: vi.fn(async (filePath: string) => {
        if (filePath === 'b.ts') {
          throw new DiscardObservedStateRequiredError('b.ts')
        }
        if (filePath === 'c.ts') {
          throw new Error('EPERM: operation not permitted')
        }
      })
    })
    const discardMany = vi.fn(async () => {
      throw new Error('unknown method: git.bulkDiscard')
    })

    const result = await runDiscardAllForArea('unstaged', ['a.ts', 'b.ts', 'c.ts'], {
      ...base,
      discardMany
    })

    expect(result.discarded).toEqual(['a.ts'])
    expect(result.refused).toEqual(['b.ts'])
    expect(result.failed).toEqual(['c.ts'])
  })

  it('still aborts before touching anything when the pre-unstage fails', async () => {
    // Unchanged behaviour, asserted so the rework above cannot quietly drop it: a clean worktree with a
    // stale index is a worse state than the one the user started in.
    const base = deps({
      bulkUnstage: vi.fn(async () => {
        throw new Error('index locked')
      })
    })
    const discardMany = vi.fn(async () => ({ discarded: ['a.ts'], refused: [] }))

    const result = await runDiscardAllForArea('staged', ['a.ts'], { ...base, discardMany })

    expect(result.aborted).toBe(true)
    expect(discardMany).not.toHaveBeenCalled()
    expect(base.discardOneCalls).toEqual([])
  })
})
