import { describe, expect, it } from 'vitest'
import {
  readShellFamilyFromLaunchTarget,
  recoverTerminalLaunchProfile,
  resolveTerminalLaunchProfileIdentity
} from './terminal-launch-profile-identity'

const profile = (id: string, label: string): { id: string; label: string } => ({ id, label })

describe('resolveTerminalLaunchProfileIdentity', () => {
  it('reads a recorded profile id as fact', () => {
    const identity = resolveTerminalLaunchProfileIdentity({ launchProfileId: 'command:kclaude' })

    expect(identity).toEqual({ source: 'recorded', profileId: 'command:kclaude' })
  })

  it('prefers the recorded id over the weaker fields a legacy tab also carries', () => {
    const identity = resolveTerminalLaunchProfileIdentity({
      launchProfileId: 'command:last-session',
      launchAgent: 'claude',
      shellOverride: 'cmd.exe'
    })

    expect(identity).toEqual({ source: 'recorded', profileId: 'command:last-session' })
  })

  it('infers an agent profile from a legacy tab', () => {
    const identity = resolveTerminalLaunchProfileIdentity({ launchAgent: 'claude' })

    expect(identity).toEqual({ source: 'inferred', profileId: 'agent:claude' })
  })

  it('infers the shell family behind whichever PowerShell the host resolved', () => {
    expect(resolveTerminalLaunchProfileIdentity({ shellOverride: 'pwsh.exe' })).toEqual({
      source: 'inferred',
      profileId: 'shell:powershell.exe'
    })
    expect(resolveTerminalLaunchProfileIdentity({ shellOverride: 'powershell.exe' })).toEqual({
      source: 'inferred',
      profileId: 'shell:powershell.exe'
    })
  })

  it('reports unknown rather than assuming the default for a tab that recorded nothing', () => {
    expect(resolveTerminalLaunchProfileIdentity({})).toEqual({ source: 'unknown' })
  })

  it('reports unknown for a shell it cannot place, instead of guessing a family', () => {
    expect(resolveTerminalLaunchProfileIdentity({ shellOverride: '/usr/bin/fish' })).toEqual({
      source: 'unknown'
    })
  })

  it('never infers a user command profile from a legacy shell, which would invent history', () => {
    // A legacy tab knows it ran cmd.exe. It cannot know whether a wrapper ran inside it, so the
    // richer profile must not claim it just because that profile also names cmd.
    const identity = resolveTerminalLaunchProfileIdentity({ shellOverride: 'cmd.exe' })

    expect(identity).toEqual({ source: 'inferred', profileId: 'shell:cmd.exe' })
  })
})

describe('readShellFamilyFromLaunchTarget', () => {
  it('places a full Git Bash path by its family marker, not its executable', () => {
    expect(readShellFamilyFromLaunchTarget('git-bash')).toBe('git-bash')
  })

  it('places an absolute PowerShell path by basename', () => {
    expect(readShellFamilyFromLaunchTarget('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe(
      'powershell.exe'
    )
  })

  it('returns nothing for blank input', () => {
    expect(readShellFamilyFromLaunchTarget('   ')).toBeNull()
    expect(readShellFamilyFromLaunchTarget(undefined)).toBeNull()
  })
})

describe('recoverTerminalLaunchProfile', () => {
  const profiles = [profile('command:kclaude', 'kClaude'), profile('shell:cmd.exe', 'Command Prompt')]

  it('finds the profile a tab was created from', () => {
    const result = recoverTerminalLaunchProfile({ launchProfileId: 'command:kclaude' }, profiles)

    expect(result).toEqual({ status: 'available', profile: profiles[0], source: 'recorded' })
  })

  it('keeps the identity when the profile is renamed', () => {
    const renamed = [profile('command:kclaude', 'kClaude (work laptop)'), profiles[1]]

    const result = recoverTerminalLaunchProfile({ launchProfileId: 'command:kclaude' }, renamed)

    expect(result).toMatchObject({ status: 'available' })
    expect(result.status === 'available' && result.profile.label).toBe('kClaude (work laptop)')
  })

  it('does not collide when two profiles share a display label', () => {
    const shared = [profile('command:a', 'Last session'), profile('command:b', 'Last session')]

    expect(recoverTerminalLaunchProfile({ launchProfileId: 'command:b' }, shared)).toEqual({
      status: 'available',
      profile: shared[1],
      source: 'recorded'
    })
  })

  it('reports a deleted profile as missing rather than falling back to the default', () => {
    const result = recoverTerminalLaunchProfile({ launchProfileId: 'command:kclaude' }, [profiles[1]])

    expect(result).toEqual({ status: 'missing', profileId: 'command:kclaude', source: 'recorded' })
  })

  it('reports unknown for a tab that recorded no launch identity', () => {
    expect(recoverTerminalLaunchProfile({}, profiles)).toEqual({ status: 'unknown' })
  })
})
