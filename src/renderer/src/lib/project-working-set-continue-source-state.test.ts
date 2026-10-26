import { describe, expect, it } from 'vitest'
import type { GitStatusResult } from '../../../shared/git-status-types'
import { continueSourceStateFromStatus } from './project-working-set-continue-source-state'

function status(over: Partial<GitStatusResult>): GitStatusResult {
  return { entries: [], conflictOperation: 'unknown', ...over } as GitStatusResult
}

describe('continueSourceStateFromStatus', () => {
  it('reads an unreadable status as unknown, never as clean', () => {
    expect(continueSourceStateFromStatus(null)).toBe('unknown')
  })

  it('reads any entry, staged, unstaged or untracked, as uncommitted changes', () => {
    const entry = { path: 'a.txt', status: 'untracked', area: 'untracked' }
    expect(continueSourceStateFromStatus(status({ entries: [entry] as never }))).toBe(
      'uncommitted-changes'
    )
  })

  it('reads a capped listing as uncommitted changes even when its entries were cut', () => {
    expect(continueSourceStateFromStatus(status({ didHitLimit: true }))).toBe('uncommitted-changes')
  })

  it('control: a read with no entries and no cap is clean', () => {
    expect(continueSourceStateFromStatus(status({}))).toBe('clean')
  })
})
