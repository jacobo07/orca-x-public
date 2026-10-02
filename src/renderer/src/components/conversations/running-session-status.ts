import type { StatusState } from '@/components/ui/status-mark'
import type { RunningSessionLiveness } from './workspace-running-sessions'

/**
 * The one system state of a running session, on every surface that draws one (Agents, Workstation).
 * An unvouched session is UNKNOWN even when its host's attempt failed: the failure is the host's,
 * drawn on the host; the agent's own state is simply not observed (STYLEGUIDE "Offline vs Failed").
 */
export function runningSessionStatus(liveness: RunningSessionLiveness): StatusState {
  switch (liveness) {
    case 'working':
      return 'HEALTHY'
    case 'needs-you':
      return 'NEEDS_APPROVAL'
    case 'done':
    case 'idle':
      return 'IDLE'
    case 'host-unvouched':
      return 'UNKNOWN'
  }
}
