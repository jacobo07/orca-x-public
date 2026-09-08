import type { TuiAgent } from '../../../src/shared/tui-agent'
import { reviewUserTerminalLaunchProfiles } from '../../../src/shared/terminal-launch-profile-definition'
import { buildTerminalLaunchProfiles } from '../../../src/shared/terminal-launch-profiles'
import { MOBILE_TUI_AGENT_LABELS } from '../tasks/mobile-tui-agents'
import { orderMobileNewTabAgents, type MobileNewTabAgentSettings } from './mobile-new-tab-agent-options'

/**
 * What this workspace can launch, composed through the same authority the desktop chooser uses.
 *
 * Mobile used to answer this from its own agents-only list, so a launch profile the user declared
 * in settings simply did not exist here -- and no test failed, because each variant only ever asked
 * its own list. Routing through `buildTerminalLaunchProfiles` means a new agent or a new profile
 * kind reaches both variants from one edit.
 */
export type MobileLaunchProfileOption = {
  /** Stable identity from the shared authority; namespaced, so ids cannot collide across kinds. */
  id: string
  label: string
  /** Present for agent profiles; absent for a declared command profile. */
  agent?: TuiAgent
  /** Present for a declared command profile; this is what makes it itself rather than a shell. */
  command?: string
  env?: Readonly<Record<string, string>>
  startupCommandDelivery?: 'fast' | 'shell-ready'
}

export type MobileLaunchProfileSettings = MobileNewTabAgentSettings & {
  terminalLaunchProfiles?: unknown
}

/**
 * Why shells are dropped rather than rendered: the drawer already carries its own plain-terminal
 * row, and mobile has no Windows shell menu to offer. Inventing shell rows here would be the same
 * mistake in the other direction -- a list mobile maintains that nothing else agrees with.
 */
export function buildMobileLaunchProfileOptions(
  settings: MobileLaunchProfileSettings | null | undefined,
  detectedAgentIds: Iterable<unknown> | null
): MobileLaunchProfileOption[] {
  if (!detectedAgentIds) {
    return []
  }
  const agents = orderMobileNewTabAgents(
    settings?.defaultTuiAgent,
    detectedAgentIds,
    settings?.disabledTuiAgents
  )
  const declared = Array.isArray(settings?.terminalLaunchProfiles)
    ? reviewUserTerminalLaunchProfiles(settings.terminalLaunchProfiles).valid
    : []

  return buildTerminalLaunchProfiles({
    shellEntries: undefined,
    agentOptions: agents.map((agent) => ({ agent, label: MOBILE_TUI_AGENT_LABELS[agent] })),
    userProfiles: declared,
    defaultAgent: settings?.defaultTuiAgent,
    hostDefaultShellLabel: ''
  })
    .profiles.filter((profile) => profile.kind !== 'shell')
    .map((profile) =>
      profile.kind === 'agent'
        ? { id: profile.id, label: profile.label, agent: profile.agent }
        : {
            id: profile.id,
            label: profile.label,
            command: profile.command,
            ...(profile.env ? { env: profile.env } : {}),
            ...(profile.startupCommandDelivery
              ? { startupCommandDelivery: profile.startupCommandDelivery }
              : {})
          }
    )
}
