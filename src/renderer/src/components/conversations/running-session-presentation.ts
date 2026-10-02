// Words for a running terminal session. On a host Orca does not observe, the sentence is the host's
// reachability, said the way Workstation says it; the mark stays UNKNOWN (running-session-status).

import { translate } from '@/i18n/i18n'
import type { StatusState } from '@/components/ui/status-mark'
import { hostReachabilityLabel } from '@/lib/host-reachability-labels'

import { runningSessionStatus } from './running-session-status'
import type { WorkspaceRunningSession } from './workspace-running-sessions'

function livenessLabel(
  session: Pick<WorkspaceRunningSession, 'liveness' | 'hostReachability'>
): string {
  switch (session.liveness) {
    case 'working':
      return translate('workspace.sessions.working', 'Working')
    case 'needs-you':
      return translate('workspace.sessions.needsYou', 'Needs you')
    case 'done':
      return translate('workspace.sessions.done', 'Done')
    case 'idle':
      return translate('workspace.sessions.idle', 'Idle')
    case 'host-unvouched':
      return hostReachabilityLabel(session.hostReachability)
  }
}

export function describeRunningSessionLiveness(
  session: Pick<WorkspaceRunningSession, 'liveness' | 'hostReachability'>
): { label: string; status: StatusState } {
  return { label: livenessLabel(session), status: runningSessionStatus(session.liveness) }
}
