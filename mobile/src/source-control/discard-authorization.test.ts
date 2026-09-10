import { describe, expect, it } from 'vitest'
import { GIT_DISCARD_STALE_STATE_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import type { MobileGitStatusEntry } from './mobile-git-status'
import {
  canDiscardSafely,
  discardConflictMessage,
  hostEnforcesDiscardPrecondition,
  resolveDiscardAuthorization
} from './discard-authorization'

function entry(overrides: Partial<MobileGitStatusEntry> = {}): MobileGitStatusEntry {
  return { path: 'a.ts', status: 'modified', area: 'unstaged', ...overrides }
}

describe('deciding whether a discard can be authorized', () => {
  it('is ready when the host checks and the row says what it held', () => {
    const authorization = resolveDiscardAuthorization(
      entry({ worktreeContentId: 'sha256:abc' }),
      true
    )

    expect(authorization).toEqual({ kind: 'ready', expectedContent: 'sha256:abc' })
    expect(canDiscardSafely(authorization)).toBe(true)
  })

  it('refuses when the host cannot check, even with an identity in hand', () => {
    // The case the capability exists for. An older host ignores a precondition it does not
    // understand, so sending one and assuming protection would be wrong exactly when it matters.
    const authorization = resolveDiscardAuthorization(
      entry({ worktreeContentId: 'sha256:abc' }),
      false
    )

    expect(authorization.kind).toBe('host-cannot-check')
    expect(canDiscardSafely(authorization)).toBe(false)
  })

  it('refuses when the host checks but the row carries no identity', () => {
    // A file the host could not read. Absence means "not computed", never "unchanged".
    const authorization = resolveDiscardAuthorization(entry(), true)

    expect(authorization.kind).toBe('state-unknown')
    expect(canDiscardSafely(authorization)).toBe(false)
  })

  it('tells the two refusals apart, because they have different fixes', () => {
    // Collapsing them would produce a message the user cannot act on: one needs a host update, the
    // other needs a refresh.
    const cannotCheck = resolveDiscardAuthorization(entry({ worktreeContentId: 'x' }), false)
    const unknownState = resolveDiscardAuthorization(entry(), true)

    expect(cannotCheck.kind === 'ready' ? '' : cannotCheck.reason).not.toBe(
      unknownState.kind === 'ready' ? '' : unknownState.reason
    )
  })

  it('treats an empty identity as no identity', () => {
    expect(resolveDiscardAuthorization(entry({ worktreeContentId: '' }), true).kind).toBe(
      'state-unknown'
    )
  })

  it('refuses when there is no row at all', () => {
    expect(resolveDiscardAuthorization(null, true).kind).toBe('state-unknown')
  })
})

describe('reading the host capability', () => {
  it('is true only when the host advertises the check', () => {
    expect(hostEnforcesDiscardPrecondition([GIT_DISCARD_STALE_STATE_RUNTIME_CAPABILITY])).toBe(true)
    expect(hostEnforcesDiscardPrecondition(['git.something-else.v1'])).toBe(false)
    expect(hostEnforcesDiscardPrecondition([])).toBe(false)
    expect(hostEnforcesDiscardPrecondition(undefined)).toBe(false)
  })
})

describe('what a refused discard tells the user', () => {
  it('describes a conflict as a save, not a failure', () => {
    const message = discardConflictMessage('stale_worktree_state')

    expect(message).toBeTruthy()
    // No hashes, no oids, no protocol words -- the user gets the outcome and the next step.
    expect(message).not.toMatch(/sha256|oid|precondition|expectedContent/i)
    expect(message).toMatch(/still here/i)
  })

  it('leaves every other failure to the message the host sent', () => {
    expect(discardConflictMessage('runtime_error')).toBeNull()
    expect(discardConflictMessage(undefined)).toBeNull()
  })
})
