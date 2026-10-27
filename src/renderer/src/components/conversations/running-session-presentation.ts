// Words for a running terminal session. The positive tone is reserved for an agent at work on a
// reachable host; an offline host is its own sentence because its fix is the connection.

import { translate } from '@/i18n/i18n'

import type { RunningSessionLiveness } from './workspace-running-sessions'

export type RunningSessionTone = 'ready' | 'caution' | 'refused' | 'neutral'

export function describeRunningSessionLiveness(liveness: RunningSessionLiveness): {
  label: string
  tone: RunningSessionTone
} {
  switch (liveness) {
    case 'working':
      return { label: translate('workspace.sessions.working', 'Working'), tone: 'ready' }
    case 'needs-you':
      return { label: translate('workspace.sessions.needsYou', 'Needs you'), tone: 'caution' }
    case 'done':
      return { label: translate('workspace.sessions.done', 'Done'), tone: 'neutral' }
    case 'idle':
      return { label: translate('workspace.sessions.idle', 'Idle'), tone: 'neutral' }
    case 'host-offline':
      return { label: translate('workspace.sessions.hostOffline', 'Host offline'), tone: 'refused' }
  }
}
