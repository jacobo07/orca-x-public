import { describe, expect, it } from 'vitest'
import {
  buildMobileSessionIdentity,
  formatWorktreePathTail,
  type MobileSessionIdentityInput
} from './mobile-session-identity-line'

function input(overrides: Partial<MobileSessionIdentityInput> = {}): MobileSessionIdentityInput {
  return {
    statusText: '1 tab',
    showStatusText: false,
    tabTitle: 'zsh',
    hostName: 'Host 1',
    worktreePath: '/home/ada/repos/orca-x/main',
    worktreeName: 'main',
    tabCount: 1,
    ...overrides
  }
}

describe('formatWorktreePathTail', () => {
  it('keeps the last two segments behind an ellipsis', () => {
    expect(formatWorktreePathTail('/home/ada/repos/orca-x/main')).toBe('…/orca-x/main')
  })

  it('handles Windows separators and a trailing separator', () => {
    expect(formatWorktreePathTail(String.raw`C:\Users\ada\orca-x\main\ `.trim())).toBe(
      '…/orca-x/main'
    )
  })

  it('does not add an ellipsis when nothing was cut', () => {
    expect(formatWorktreePathTail('/orca-x/main')).toBe('/orca-x/main')
    expect(formatWorktreePathTail('repo')).toBe('repo')
  })

  it('returns null for a path with no segments', () => {
    expect(formatWorktreePathTail('/')).toBeNull()
    expect(formatWorktreePathTail('  ')).toBeNull()
  })
})

describe('buildMobileSessionIdentity', () => {
  it('shows tab, host and path tail when connected', () => {
    expect(buildMobileSessionIdentity(input()).segments).toEqual(['zsh', 'Host 1', '…/orca-x/main'])
  })

  it('shows the status text instead of the tab while not connected or loading', () => {
    const identity = buildMobileSessionIdentity(
      input({ showStatusText: true, statusText: 'Reconnecting — tap to retry' })
    )
    expect(identity.segments[0]).toBe('Reconnecting — tap to retry')
  })

  it('falls back to the status text when there is no active tab title', () => {
    expect(buildMobileSessionIdentity(input({ tabTitle: null })).segments[0]).toBe('1 tab')
  })

  it('omits segments it does not know instead of inventing them', () => {
    expect(
      buildMobileSessionIdentity(input({ hostName: null, worktreePath: null })).segments
    ).toEqual(['zsh'])
    expect(buildMobileSessionIdentity(input({ hostName: '  ' })).segments).toEqual([
      'zsh',
      '…/orca-x/main'
    ])
  })

  it('keeps the worktree name, tab count and full path in the accessibility label', () => {
    const label = buildMobileSessionIdentity(input({ tabCount: 3 })).accessibilityLabel
    expect(label).toContain('main')
    expect(label).toContain('3 tabs')
    expect(label).toContain('Host 1')
    expect(label).toContain('/home/ada/repos/orca-x/main')
  })

  it('uses the singular for one tab and says nothing about tabs while showing status', () => {
    expect(buildMobileSessionIdentity(input()).accessibilityLabel).toContain('1 tab')
    expect(buildMobileSessionIdentity(input()).accessibilityLabel).not.toContain('1 tabs')
    const offline = buildMobileSessionIdentity(
      input({ showStatusText: true, statusText: 'Offline' })
    ).accessibilityLabel
    expect(offline).toContain('Offline')
    expect(offline).not.toContain('tab,')
  })
})
