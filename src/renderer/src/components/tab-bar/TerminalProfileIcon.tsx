import React from 'react'
import { AgentIcon } from '@/lib/agent-catalog'
import { ShellIcon } from './shell-icons'
import type { TerminalLaunchProfile } from '@/lib/terminal-launch-profiles'

/**
 * The icon for a launch profile, in one place.
 *
 * Two menus render the same profile set, and a branch on `kind` copied into both is how they start
 * disagreeing about what a profile looks like — the same drift that had them disagreeing about
 * which profiles exist.
 */
export function TerminalProfileIcon({
  profile,
  size = 14
}: {
  profile: TerminalLaunchProfile
  size?: number
}): React.ReactElement {
  if (profile.kind === 'agent') {
    return <AgentIcon agent={profile.agent} size={size} />
  }
  return <ShellIcon shell={profile.shell ?? undefined} size={size} />
}
