import { describe, expect, it, vi, beforeEach } from 'vitest'
import { toast } from 'sonner'
import { launchTerminalProfile } from './launch-terminal-profile'
import type { TerminalLaunchProfile } from './terminal-launch-profiles'

vi.mock('sonner', () => ({ toast: { warning: vi.fn() } }))
vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTab: vi.fn() }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const PROFILES: TerminalLaunchProfile[] = [
  { kind: 'shell', id: 'shell:default', label: 'Terminal', shell: null }
]

function launch(profileId: string, onNewTerminalTab: () => void): void {
  launchTerminalProfile({
    profileId,
    profiles: PROFILES,
    worktreeId: 'worktree-1',
    powerShellImplementation: 'auto',
    pwshAvailable: false,
    onNewTerminalTab
  })
}

describe('launchTerminalProfile', () => {
  beforeEach(() => {
    vi.mocked(toast.warning).mockClear()
  })

  it('announces the substitution when the chosen profile is gone', () => {
    // Arrange
    const onNewTerminalTab = vi.fn()

    // Act — an id that was in the menu when it opened but is absent now.
    launch('agent:claude', onNewTerminalTab)

    // Assert — still useful, but not silently a different runtime than the one chosen.
    expect(onNewTerminalTab).toHaveBeenCalledTimes(1)
    expect(toast.warning).toHaveBeenCalledTimes(1)
    expect(vi.mocked(toast.warning).mock.calls[0]?.[0]).toContain('no longer available')
  })

  it('stays quiet when the chosen profile resolves', () => {
    // Arrange
    const onNewTerminalTab = vi.fn()

    // Act
    launch('shell:default', onNewTerminalTab)

    // Assert — a successful launch owes the user no notice.
    expect(onNewTerminalTab).toHaveBeenCalledTimes(1)
    expect(toast.warning).not.toHaveBeenCalled()
  })
})
