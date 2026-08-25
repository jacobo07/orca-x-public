import { describe, expect, it } from 'vitest'
import { reviewUserTerminalLaunchProfiles } from './terminal-launch-profile-definition'

const GOOD = { id: 'kclaude', label: 'kClaude', command: 'kclaude.cmd --no-chrome' }

describe('user terminal launch profile review', () => {
  it('accepts a complete profile and trims its identity', () => {
    const { valid, invalid } = reviewUserTerminalLaunchProfiles([{ ...GOOD, id: '  kclaude  ' }])

    expect(invalid).toEqual([])
    expect(valid).toEqual([{ id: 'kclaude', label: 'kClaude', command: 'kclaude.cmd --no-chrome' }])
  })

  it('keeps the good entries when one is malformed', () => {
    const { valid, invalid } = reviewUserTerminalLaunchProfiles([
      { label: 'No id', command: 'x' },
      GOOD
    ])

    expect(valid.map((profile) => profile.id)).toEqual(['kclaude'])
    expect(invalid).toEqual([{ index: 0, reason: 'missing-id' }])
  })

  it('rejects a duplicate id rather than letting it shadow the first', () => {
    const { valid, invalid } = reviewUserTerminalLaunchProfiles([
      GOOD,
      { ...GOOD, label: 'Impostor', command: 'other' }
    ])

    expect(valid.map((profile) => profile.label)).toEqual(['kClaude'])
    expect(invalid).toEqual([{ index: 1, reason: 'duplicate-id' }])
  })

  it('rejects a non-string environment value instead of coercing it', () => {
    const { valid, invalid } = reviewUserTerminalLaunchProfiles([
      { ...GOOD, env: { SLOT: 2 as unknown as string } }
    ])

    expect(valid).toEqual([])
    expect(invalid).toEqual([{ index: 0, reason: 'invalid-env' }])
  })

  it('carries env, shell, delivery and prerequisite through', () => {
    const { valid } = reviewUserTerminalLaunchProfiles([
      {
        ...GOOD,
        env: { LAZARUS_TERMINAL_KEY: 'slot2' },
        shell: 'cmd.exe',
        startupCommandDelivery: 'shell-ready',
        requiresPath: 'C:/Users/me/.claude/bin/kclaude.cmd'
      }
    ])

    expect(valid[0]).toEqual({
      id: 'kclaude',
      label: 'kClaude',
      command: 'kclaude.cmd --no-chrome',
      env: { LAZARUS_TERMINAL_KEY: 'slot2' },
      shell: 'cmd.exe',
      startupCommandDelivery: 'shell-ready',
      requiresPath: 'C:/Users/me/.claude/bin/kclaude.cmd'
    })
  })

  it('treats absent and empty input as no profiles, not as an error', () => {
    expect(reviewUserTerminalLaunchProfiles(undefined)).toEqual({ valid: [], invalid: [] })
    expect(reviewUserTerminalLaunchProfiles([])).toEqual({ valid: [], invalid: [] })
  })

  it('ignores an unknown delivery mode rather than passing it to the spawn path', () => {
    const { valid } = reviewUserTerminalLaunchProfiles([
      { ...GOOD, startupCommandDelivery: 'whenever' }
    ])

    expect(valid[0]?.startupCommandDelivery).toBeUndefined()
  })
})
