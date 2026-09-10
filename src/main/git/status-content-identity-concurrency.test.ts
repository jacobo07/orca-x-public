import { describe, expect, it, vi } from 'vitest'
import {
  readWorktreeContentIdentity,
  WORKTREE_CONTENT_IDENTITY_CONCURRENCY
} from '../../shared/worktree-content-identity'
import type { GitStatusEntry } from '../../shared/git-status-types'
import { attachWorktreeContentIdentities } from './status'

/**
 * Stamping reads each changed file whole, so the fan-out is a memory budget, not a speed knob.
 *
 * Measured on this path: RSS tracks file size exactly (an 8MB file costs 8MB), and starting every
 * read at once turned 24 ordinary 8MB files into a 128MB resident burst on a single Source Control
 * refresh. Unbounded, peak cost is the SUM of every changed file -- which a repo reaches with a few
 * build artifacts, not with anything exotic.
 */
vi.mock('../../shared/worktree-content-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../shared/worktree-content-identity')>()),
  readWorktreeContentIdentity: vi.fn()
}))

function entries(count: number): GitStatusEntry[] {
  return Array.from({ length: count }, (_, index) => ({ path: `file-${index}.ts` }) as GitStatusEntry)
}

describe('stamping worktree content identities', () => {
  it('does not read every changed file at once', async () => {
    let inFlight = 0
    let peak = 0
    vi.mocked(readWorktreeContentIdentity).mockImplementation(async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight -= 1
      return 'sha256:stamped'
    })

    const changed = entries(64)
    await attachWorktreeContentIdentities('/repo', changed)

    expect(peak).toBeLessThanOrEqual(WORKTREE_CONTENT_IDENTITY_CONCURRENCY)
    // The bound must cost coverage, not just concurrency: every row still gets its identity, or a
    // client would silently lose the ability to authorize a discard it could previously describe.
    expect(changed.every((entry) => entry.worktreeContentId === 'sha256:stamped')).toBe(true)
  })

  it('still leaves an unreadable entry unstamped rather than guessing', async () => {
    vi.mocked(readWorktreeContentIdentity).mockRejectedValue(new Error('EACCES'))

    const changed = entries(3)
    await attachWorktreeContentIdentities('/repo', changed)

    expect(changed.every((entry) => entry.worktreeContentId === undefined)).toBe(true)
  })
})
