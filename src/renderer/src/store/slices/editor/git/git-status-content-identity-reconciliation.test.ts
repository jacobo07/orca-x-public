import { describe, expect, it } from 'vitest'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import { areGitStatusEntriesEqual } from './git-status-reconciliation'

/**
 * The identity a discard is authorized against has to be a field this comparator can see.
 *
 * The comparator decides whether a status refresh reaches the store at all, so a field it ignores
 * freezes at whatever value it had when some *other* field last changed. For a value the UI merely
 * renders that is a cosmetic lag. For the state a destructive operation is authorized against it is
 * worse than a lag in one direction and a permanent wall in the other: the host would keep refusing
 * against content the user replaced long ago, and no refresh could ever clear it, because the only
 * thing that changed is the field the comparator does not look at.
 *
 * The case that makes it concrete is a same-shape edit -- replace one line with a different line of
 * the same length. Path, status, area and both line counts are identical; only the bytes moved.
 */
function entry(overrides: Partial<GitStatusEntry> = {}): GitStatusEntry {
  return {
    path: 'src/a.ts',
    status: 'modified',
    area: 'unstaged',
    added: 1,
    removed: 1,
    ...overrides
  }
}

describe('reconciling a status refresh that only moved the working-tree bytes', () => {
  it('treats a changed content identity as a change', () => {
    const before = [entry({ worktreeContentId: 'sha256:aaa' })]
    const after = [entry({ worktreeContentId: 'sha256:bbb' })]

    expect(areGitStatusEntriesEqual(before, after)).toBe(false)
  })

  it('treats losing the identity as a change, because absence is not "unchanged"', () => {
    // A host that stops stamping -- a downgrade, a read that failed, a capped listing -- must not
    // leave the previous identity standing in the store as if it were still the current state.
    const before = [entry({ worktreeContentId: 'sha256:aaa' })]
    const after = [entry()]

    expect(areGitStatusEntriesEqual(before, after)).toBe(false)
  })

  it('still reports an identical pair as unchanged, so the poll does not thrash the store', () => {
    // The other half: a comparator that answered false for everything would pass both tests above
    // while making every poll re-render the panel.
    const before = [entry({ worktreeContentId: 'sha256:aaa' })]
    const after = [entry({ worktreeContentId: 'sha256:aaa' })]

    expect(areGitStatusEntriesEqual(before, after)).toBe(true)
  })

  it('still reports an unstamped identical pair as unchanged', () => {
    expect(areGitStatusEntriesEqual([entry()], [entry()])).toBe(true)
  })
})
