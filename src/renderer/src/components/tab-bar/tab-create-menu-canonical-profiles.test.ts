import { describe, expect, it } from 'vitest'
import {
  buildTabCreateMenuOptions,
  findMatchingTabCreateMenuOptions
} from './tab-create-menu-options'
import type { TerminalLaunchProfile } from '@/lib/terminal-launch-profiles'

/**
 * The create menu must offer what the canonical profile set offers.
 *
 * It used to build its terminal rows from the Windows shell list alone, so an agent the rail's
 * profile menu offered was unreachable by search here — two surfaces answering "what can this
 * workspace launch" with different answers. The set is derived once; a surface may filter it, but
 * none may build its own.
 */

const PROFILES: readonly TerminalLaunchProfile[] = [
  { kind: 'shell', id: 'shell:powershell.exe', label: 'PowerShell', shell: 'powershell.exe' },
  { kind: 'shell', id: 'shell:git-bash', label: 'Git Bash', shell: 'git-bash' },
  { kind: 'agent', id: 'agent:claude', label: 'Claude', agent: 'claude' }
]

const BASE = {
  terminalOnly: false,
  hasNewBrowser: false,
  hasNewMarkdown: false,
  hasOpenMarkdown: false,
  hasSimulator: false,
  simulatorIsGoTo: false
} as const

describe('create menu reads the canonical profile set', () => {
  it('offers one row per profile, agents included', () => {
    const options = buildTabCreateMenuOptions({ ...BASE, profiles: PROFILES })

    expect(options.map((option) => option.profileId)).toEqual([
      'shell:powershell.exe',
      'shell:git-bash',
      'agent:claude'
    ])
    expect(new Set(options.map((option) => option.kind))).toEqual(
      new Set(['new-terminal-profile'])
    )
  })

  it('finds an agent profile by name', () => {
    const options = buildTabCreateMenuOptions({ ...BASE, profiles: PROFILES })

    expect(findMatchingTabCreateMenuOptions('claude', options).map((o) => o.profileId)).toEqual([
      'agent:claude'
    ])
  })

  it('falls back to a plain terminal row when no profile set resolved yet', () => {
    const options = buildTabCreateMenuOptions({ ...BASE, profiles: [] })

    expect(options.map((option) => option.kind)).toEqual(['new-terminal'])
  })
})
