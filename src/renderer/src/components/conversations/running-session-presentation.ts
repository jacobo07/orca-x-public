// Words for a running terminal session. HEALTHY is reserved for an agent at work on a host Orca
// observes; on any other host the sentence and the mark are the host's reachability, said the way
// Workstation says it, because the agent's last state cannot be vouched for.

import { translate } from '@/i18n/i18n'
import type { StatusState } from '@/components/ui/status-mark'
import { hostReachabilityStatus } from '@/lib/host-reachability'
import { hostReachabilityLabel } from '@/lib/host-reachability-labels'

import type { WorkspaceRunningSession } from './workspace-running-sessions'

export function describeRunningSessionLiveness(
  session: Pick<WorkspaceRunningSession, 'liveness' | 'hostReachability'>
): { label: string; status: StatusState } {
  switch (session.liveness) {
    case 'working':
      return { label: translate('workspace.sessions.working', 'Working'), status: 'HEALTHY' }
    case 'needs-you':
      return {
        label: translate('workspace.sessions.needsYou', 'Needs you'),
        status: 'NEEDS_APPROVAL'
      }
    case 'done':
      return { label: translate('workspace.sessions.done', 'Done'), status: 'IDLE' }
    case 'idle':
      return { label: translate('workspace.sessions.idle', 'Idle'), status: 'IDLE' }
    case 'host-unvouched':
      return {
        label: hostReachabilityLabel(session.hostReachability),
        status: hostReachabilityStatus(session.hostReachability)
      }
  }
}
