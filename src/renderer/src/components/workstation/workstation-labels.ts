import { translate } from '@/i18n/i18n'
import type { ProjectHostSetupState } from '../../../../shared/project-types'
import type { WorkstationAgentState, WorkstationNode } from './workstation-projection'

export function hostKindLabel(node: WorkstationNode): string {
  switch (node.host?.kind) {
    case 'local':
      return translate('workstation.kind.local', 'This computer')
    case 'ssh':
      return translate('workstation.kind.ssh', 'SSH host')
    case 'runtime':
      return translate('workstation.kind.runtime', 'Orca server')
    case undefined:
      return translate('workstation.kind.unregistered', 'Host no longer configured')
  }
}

export function failureLabel(node: WorkstationNode): string | null {
  switch (node.failure) {
    case 'auth-failed':
      return translate('workstation.failure.auth', 'Authentication failed.')
    case 'reconnection-failed':
      return translate('workstation.failure.reconnect', 'Reconnecting failed.')
    case 'error':
    case 'runtime-error':
      return translate('workstation.failure.error', 'The last connection attempt failed.')
    case null:
      break
  }
  switch (node.blocked) {
    case 'client-too-old':
      return translate(
        'workstation.blocked.clientTooOld',
        'This Orca is older than the host needs.'
      )
    case 'server-too-old':
      return translate(
        'workstation.blocked.serverTooOld',
        'The host runs an older Orca than this one needs.'
      )
    case null:
      return null
  }
}

/** Saved setup state, worded as setup — never "Ready", which would read as reachability. */
export function setupStateLabel(state: ProjectHostSetupState): string {
  switch (state) {
    case 'ready':
      return translate('workstation.setup.ready', 'Set up')
    case 'not-set-up':
      return translate('workstation.setup.notSetUp', 'Not set up')
    case 'setting-up':
      return translate('workstation.setup.settingUp', 'Setting up')
    case 'error':
      return translate('workstation.setup.error', 'Setup failed')
    case 'unsupported':
      return translate('workstation.setup.unsupported', 'Unsupported')
  }
}

export function agentStateLabel(state: WorkstationAgentState): string {
  switch (state) {
    case 'needs-you':
      return translate('workstation.agent.needsYou', 'Needs you')
    case 'working':
      return translate('workstation.agent.working', 'Working')
    case 'done':
      return translate('workstation.agent.done', 'Done')
    case 'idle':
      return translate('workstation.agent.idle', 'Idle')
    case 'unknown':
      return translate('workstation.agent.unknown', 'Unknown while the host is not connected')
  }
}
