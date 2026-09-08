import { describe, expect, it } from 'vitest'

import { buildMobileLaunchProfileOptions } from './mobile-launch-profile-options'

/**
 * Desktop and mobile must not answer "what can this workspace launch" from two different lists.
 *
 * Desktop composes agents, shells and user-declared launch profiles in
 * `src/shared/terminal-launch-profiles.ts`. Mobile reached the same question through its own
 * agents-only builder, so a launch profile the user declared in settings existed on one variant and
 * not the other -- and nothing failed, because each side's tests only ever asked its own list.
 *
 * These pin the capability, not the presentation: mobile may render a profile however it likes, but
 * it may not be unable to name one.
 */
describe('mobile launch profiles come from the same authority as desktop', () => {
  const userProfile = {
    id: 'prod-ssh',
    label: 'Production SSH',
    command: 'ssh deploy@prod'
  }

  it('offers a launch profile the user declared in settings', () => {
    const options = buildMobileLaunchProfileOptions(
      { defaultTuiAgent: null, terminalLaunchProfiles: [userProfile] },
      ['codex']
    )

    expect(options.map((option) => option.label)).toContain('Production SSH')
  })

  it('carries the command that makes a declared profile itself, not a bare shell', () => {
    const options = buildMobileLaunchProfileOptions(
      { defaultTuiAgent: null, terminalLaunchProfiles: [userProfile] },
      ['codex']
    )
    const declared = options.find((option) => option.label === 'Production SSH')

    // A profile that arrives without its command launches an ordinary terminal under a name that
    // promises something else, which is worse than not offering it.
    expect(declared?.command).toBe('ssh deploy@prod')
  })

  it('still offers the detected agents alongside the declared profiles', () => {
    const options = buildMobileLaunchProfileOptions(
      { defaultTuiAgent: null, terminalLaunchProfiles: [userProfile] },
      ['codex', 'claude']
    )

    expect(options.map((option) => option.agent)).toEqual(
      expect.arrayContaining(['codex', 'claude'])
    )
  })

  it('drops a malformed declared profile without dropping the valid ones beside it', () => {
    const options = buildMobileLaunchProfileOptions(
      {
        defaultTuiAgent: null,
        terminalLaunchProfiles: [{ id: 'broken' }, userProfile]
      },
      ['codex']
    )

    expect(options.map((option) => option.label)).toContain('Production SSH')
  })
})
