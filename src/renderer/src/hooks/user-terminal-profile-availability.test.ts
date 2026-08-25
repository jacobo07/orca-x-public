import { describe, expect, it } from 'vitest'
import type { UserTerminalLaunchProfile } from '../../../shared/terminal-launch-profile-definition'
import {
  classifyUserTerminalProfileAvailability,
  type ProbeOutcome
} from './useAvailableUserTerminalProfiles'

const wrapperProfile: UserTerminalLaunchProfile = {
  id: 'last-session',
  label: 'Last session',
  command: 'autoresume.bat',
  requiresPath: 'C:\\wrappers\\autoresume.bat'
}

const plainProfile: UserTerminalLaunchProfile = {
  id: 'notes',
  label: 'Notes',
  command: 'echo hello'
}

const classify = (probes: [string, ProbeOutcome][] = []) =>
  classifyUserTerminalProfileAvailability([wrapperProfile, plainProfile], new Map(probes))

describe('classifyUserTerminalProfileAvailability', () => {
  it('offers a profile that declares no prerequisite without probing anything', () => {
    const { entries, profiles } = classify()

    expect(entries.find((e) => e.profile.id === 'notes')?.state).toBe('available')
    expect(profiles.map((p) => p.id)).toContain('notes')
  })

  it('offers a profile whose prerequisite was proven present', () => {
    const { profiles } = classify([[wrapperProfile.requiresPath!, 'present']])

    expect(profiles.map((p) => p.id)).toContain('last-session')
  })

  it('separates a still-running probe from a prerequisite proven absent', () => {
    const probing = classify().entries.find((e) => e.profile.id === 'last-session')
    const absent = classify([[wrapperProfile.requiresPath!, 'absent']]).entries.find(
      (e) => e.profile.id === 'last-session'
    )

    expect(probing?.state).toBe('probing')
    expect(absent?.state).toBe('prerequisite-missing')
    expect(probing?.state).not.toBe(absent?.state)
  })

  it('does not report a failed probe as proof the prerequisite is missing', () => {
    // The distinction that matters: a dropped SSH connection and a deleted wrapper both stop the
    // profile launching, but only one of them is fixed by reinstalling anything.
    const { entries } = classify([[wrapperProfile.requiresPath!, 'failed']])

    expect(entries.find((e) => e.profile.id === 'last-session')?.state).toBe('probe-unavailable')
  })

  it('withholds the launch for every state that is not proven availability', () => {
    for (const outcome of ['absent', 'failed'] as const) {
      const { profiles } = classify([[wrapperProfile.requiresPath!, outcome]])
      expect(profiles.map((p) => p.id)).not.toContain('last-session')
    }
    expect(classify().profiles.map((p) => p.id)).not.toContain('last-session')
  })

  it('keeps every declared profile visible with a verdict, not only the launchable ones', () => {
    const { entries } = classify([[wrapperProfile.requiresPath!, 'absent']])

    expect(entries).toHaveLength(2)
    expect(entries.map((e) => e.profile.id).sort()).toEqual(['last-session', 'notes'])
  })

  it('reports which prerequisite a verdict is about', () => {
    const { entries } = classify([[wrapperProfile.requiresPath!, 'absent']])

    expect(entries.find((e) => e.profile.id === 'last-session')?.requiresPath).toBe(
      'C:\\wrappers\\autoresume.bat'
    )
  })
})
