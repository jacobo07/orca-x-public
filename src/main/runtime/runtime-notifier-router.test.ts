import { describe, expect, it } from 'vitest'
import type { RuntimeNotifier } from './orca-runtime'
import {
  RUNTIME_NOTIFIER_AUTHORITY,
  resolveNotifierTargets,
  type NotifierAuthority
} from './runtime-notifier-router'

const windowA = { name: 'A' } as unknown as RuntimeNotifier
const windowB = { name: 'B' } as unknown as RuntimeNotifier

function resolve(
  authority: NotifierAuthority,
  overrides: Partial<Parameters<typeof resolveNotifierTargets>[0]> = {}
) {
  return resolveNotifierTargets({
    owned: undefined,
    registered: [windowA, windowB],
    authority,
    placement: undefined,
    ...overrides
  })
}

describe('resolveNotifierTargets', () => {
  it('sends to the owning window whatever the authority', () => {
    for (const authority of ['global', 'notify', 'read', 'act', 'place'] as const) {
      expect(resolve(authority, { owned: windowB })).toEqual({
        kind: 'owner',
        notifiers: [windowB]
      })
    }
  })

  it('keeps the single-window meaning: the only window is the owner', () => {
    for (const authority of ['read', 'act', 'place'] as const) {
      expect(resolve(authority, { registered: [windowA] })).toEqual({
        kind: 'single-window',
        notifiers: [windowA]
      })
    }
  })

  it('refuses a read or an act on a target no window owns, instead of reaching every window', () => {
    expect(resolve('act')).toEqual({ kind: 'refused', notifiers: [] })
    expect(resolve('read')).toEqual({ kind: 'refused', notifiers: [] })
  })

  it('places an unowned target in exactly one window, preferring the last focused', () => {
    expect(resolve('place', { placement: windowB })).toEqual({
      kind: 'placed',
      notifiers: [windowB]
    })
    expect(resolve('place')).toEqual({ kind: 'placed', notifiers: [windowA] })
  })

  it('ignores a placement window that is no longer registered', () => {
    const closed = { name: 'closed' } as unknown as RuntimeNotifier
    expect(resolve('place', { placement: closed }).notifiers).toEqual([windowA])
  })

  it('still broadcasts notifications and global state', () => {
    expect(resolve('notify').notifiers).toEqual([windowA, windowB])
    expect(resolve('global').notifiers).toEqual([windowA, windowB])
  })
})

describe('RUNTIME_NOTIFIER_AUTHORITY', () => {
  it('never lets a destructive or user-text method broadcast', () => {
    const mustNotBroadcast = [
      'closeTerminalTab',
      'closeTerminal',
      'closeSessionTab',
      'sleepWorktree',
      'saveMobileMarkdownTab',
      'nativeChatLaunchDraftResolved',
      'activateWorktree',
      'createTerminal',
      'resumeSleepingAgents'
    ] as const
    for (const method of mustNotBroadcast) {
      expect(
        ['global', 'notify'].includes(RUNTIME_NOTIFIER_AUTHORITY[method]),
        `${method} would reach every window when unowned`
      ).toBe(false)
    }
  })
})
