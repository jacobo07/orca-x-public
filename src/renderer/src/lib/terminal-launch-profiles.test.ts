import { describe, expect, it } from 'vitest'
import {
  HOST_DEFAULT_SHELL_PROFILE_ID,
  agentProfileId,
  buildTerminalLaunchProfiles,
  findTerminalLaunchProfile
} from './terminal-launch-profiles'

const WINDOWS_SHELLS = [
  { label: 'PowerShell', shell: 'powershell.exe' },
  { label: 'CMD Prompt', shell: 'cmd.exe' }
] as const

const AGENTS = [
  { agent: 'claude', label: 'Claude' },
  { agent: 'codex', label: 'Codex' }
] as const

describe('buildTerminalLaunchProfiles', () => {
  it('offers shells and agents from one list', () => {
    const { profiles } = buildTerminalLaunchProfiles({
      shellEntries: WINDOWS_SHELLS,
      agentOptions: AGENTS,
      defaultAgent: null,
      hostDefaultShellLabel: 'Terminal'
    })

    expect(profiles.map((profile) => profile.id)).toEqual([
      'shell:powershell.exe',
      'shell:cmd.exe',
      'agent:claude',
      'agent:codex'
    ])
  })

  it('makes the configured default agent the default profile, and puts it first', () => {
    const { profiles, defaultProfileId } = buildTerminalLaunchProfiles({
      shellEntries: WINDOWS_SHELLS,
      agentOptions: AGENTS,
      defaultAgent: 'codex',
      hostDefaultShellLabel: 'Terminal'
    })

    expect(defaultProfileId).toBe(agentProfileId('codex'))
    expect(profiles[0]?.id).toBe(agentProfileId('codex'))
  })

  it("treats 'blank' as a shell default, not as an absent one", () => {
    // 'blank' is the settings value for "plain terminal, no agent". Reading it as missing would
    // silently hand the primary + button to whichever agent happens to be installed first.
    const { defaultProfileId } = buildTerminalLaunchProfiles({
      shellEntries: WINDOWS_SHELLS,
      agentOptions: AGENTS,
      defaultAgent: 'blank',
      hostDefaultShellLabel: 'Terminal'
    })

    expect(defaultProfileId).toBe('shell:powershell.exe')
  })

  it('falls back to the shell when the configured default agent is not available here', () => {
    // Settings survive a machine change; the agent named there may not be installed on this one.
    const { defaultProfileId } = buildTerminalLaunchProfiles({
      shellEntries: WINDOWS_SHELLS,
      agentOptions: AGENTS,
      defaultAgent: 'gemini',
      hostDefaultShellLabel: 'Terminal'
    })

    expect(defaultProfileId).toBe('shell:powershell.exe')
  })

  it('synthesises the host shell when no explicit shell menu applies', () => {
    // A POSIX host offers no shell picker, but a plain terminal is still launchable — and the
    // primary + button must have something to launch.
    const { profiles, defaultProfileId } = buildTerminalLaunchProfiles({
      shellEntries: undefined,
      agentOptions: AGENTS,
      defaultAgent: 'blank',
      hostDefaultShellLabel: 'Terminal'
    })

    expect(defaultProfileId).toBe(HOST_DEFAULT_SHELL_PROFILE_ID)
    expect(findTerminalLaunchProfile(profiles, HOST_DEFAULT_SHELL_PROFILE_ID)).toMatchObject({
      kind: 'shell',
      shell: null
    })
  })

  it('never duplicates the host shell alongside a real shell menu', () => {
    const { profiles } = buildTerminalLaunchProfiles({
      shellEntries: WINDOWS_SHELLS,
      agentOptions: [],
      defaultAgent: null,
      hostDefaultShellLabel: 'Terminal'
    })

    expect(findTerminalLaunchProfile(profiles, HOST_DEFAULT_SHELL_PROFILE_ID)).toBeNull()
  })

  it('keeps shell and agent ids apart when their names collide', () => {
    // `cursor` is a real TuiAgent; an unnamespaced id space would let a shell of the same name
    // shadow it, and the dropdown would launch the wrong thing.
    const { profiles } = buildTerminalLaunchProfiles({
      shellEntries: [{ label: 'Cursor', shell: 'cmd.exe' }],
      agentOptions: [{ agent: 'cursor', label: 'Cursor' }],
      defaultAgent: null,
      hostDefaultShellLabel: 'Terminal'
    })

    expect(new Set(profiles.map((profile) => profile.id)).size).toBe(2)
  })

  it('always leaves something for the primary action to launch', () => {
    const { profiles, defaultProfileId } = buildTerminalLaunchProfiles({
      shellEntries: [],
      agentOptions: [],
      defaultAgent: null,
      hostDefaultShellLabel: 'Terminal'
    })

    // An empty shell menu still synthesises the host shell, so "nothing to launch" cannot happen
    // in practice — assert the shape that guarantees it rather than an empty list.
    expect(profiles).toHaveLength(1)
    expect(defaultProfileId).toBe(HOST_DEFAULT_SHELL_PROFILE_ID)
  })
})
