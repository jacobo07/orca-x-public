// Words for a running terminal session. The positive tone is reserved for an agent at work on a
// host Orca observes; on any other host the sentence is the host's reachability, said the way
// Workstation says it, because the agent's last state cannot be vouched for.

import { translate } from '@/i18n/i18n'
import { hostReachabilityLabel } from '@/lib/host-reachability-labels'

import type { WorkspaceRunningSession } from './workspace-running-sessions'

export type RunningSessionTone = 'ready' | 'caution' | 'refused' | 'neutral' | 'unknown'

export function describeRunningSessionLiveness(
  session: Pick<WorkspaceRunningSession, 'liveness' | 'hostReachability'>
): { label: string; tone: RunningSessionTone } {
  switch (session.liveness) {
    case 'working':
      return { label: translate('workspace.sessions.working', 'Working'), tone: 'ready' }
    case 'needs-you':
      return { label: translate('workspace.sessions.needsYou', 'Needs you'), tone: 'caution' }
    case 'done':
      return { label: translate('workspace.sessions.done', 'Done'), tone: 'neutral' }
    case 'idle':
      return { label: translate('workspace.sessions.idle', 'Idle'), tone: 'neutral' }
    case 'host-unvouched':
      return {
        label: hostReachabilityLabel(session.hostReachability),
        tone: session.hostReachability === 'failed' ? 'refused' : 'unknown'
      }
  }
}
