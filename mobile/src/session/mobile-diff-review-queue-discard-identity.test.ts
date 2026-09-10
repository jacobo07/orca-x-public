import { describe, expect, it } from 'vitest'
import type { MobileGitStatusEntry } from '../source-control/mobile-git-status'
import { buildMobileDiffReviewQueue } from './mobile-diff-review-queue'

/**
 * The narrowing boundary, pinned.
 *
 * `MobileGitStatusEntry` is the shared status entry re-exported, so a field added host-side reaches
 * mobile's type for free. The queue item is NOT -- it is a hand-written projection, so a field that
 * nobody copies here disappears silently on its way to the review surface, and no type error says
 * so. That is the failure this branch has now hit four times, and this file is the assertion that
 * makes the fifth one red.
 */
function statusEntry(overrides: Partial<MobileGitStatusEntry> = {}): MobileGitStatusEntry {
  return { path: 'a.ts', status: 'modified', area: 'unstaged', ...overrides }
}

function buildQueue(entries: MobileGitStatusEntry[]) {
  return buildMobileDiffReviewQueue({
    worktreeId: 'wt-1',
    statusEntries: entries,
    branchEntries: [],
    comments: [],
    reviewState: { files: {} } as never
  })
}

describe('the review queue keeps what a discard needs to name', () => {
  it('carries the content identity through the projection', () => {
    const queue = buildQueue([statusEntry({ worktreeContentId: 'sha256:abc' })])

    expect(queue[0]?.worktreeContentId).toBe('sha256:abc')
  })

  it('leaves it off when the status row had none', () => {
    const queue = buildQueue([statusEntry()])

    expect(queue[0]?.worktreeContentId).toBeUndefined()
  })

  it('does not confuse it with the identity used to detect a changed row', () => {
    // diffIdentity is built from the path, the status letter and the line counts. Both entries here
    // are one line replaced by one line, so it is identical across them -- which is why it cannot be
    // the destructive precondition, however convenient it looks.
    const first = buildQueue([
      statusEntry({ worktreeContentId: 'sha256:aaa', added: 1, removed: 1 })
    ])
    const second = buildQueue([
      statusEntry({ worktreeContentId: 'sha256:bbb', added: 1, removed: 1 })
    ])

    expect(first[0]?.diffIdentity).toBe(second[0]?.diffIdentity)
    expect(first[0]?.worktreeContentId).not.toBe(second[0]?.worktreeContentId)
  })
})
