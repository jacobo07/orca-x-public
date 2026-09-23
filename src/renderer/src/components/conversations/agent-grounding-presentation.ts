// Words for an agent's grounding. Each outcome keeps its own sentence because each has its own fix;
// the only positive tone is reserved for a location the turn runner would actually run in.

import { translate } from '@/i18n/i18n'
import type {
  AgentGroundingLocation,
  AgentGroundingProvider
} from '../../../../shared/agent-grounding'

export type GroundingTone = 'ready' | 'caution' | 'refused' | 'neutral'

export type GroundingFact = { label: string; detail: string | null; tone: GroundingTone }

const SETUP_STATE_LABEL: Record<string, () => string> = {
  'not-set-up': () => translate('workspace.setup.notSetUp', 'Not set up on this computer'),
  'setting-up': () => translate('workspace.setup.settingUp', 'Setting up'),
  error: () => translate('workspace.setup.error', 'Setup failed'),
  unsupported: () => translate('workspace.setup.unsupported', 'Not supported on this computer'),
  ready: () => translate('workspace.setup.ready', 'Ready')
}

/** Where the next turn runs. `no-project` is not a refusal: the runner uses the home folder. */
export function describeTurnLocation(location: AgentGroundingLocation): GroundingFact {
  switch (location.outcome) {
    case 'resolved':
      return {
        label: translate('workspace.location.thisComputer', 'This computer'),
        detail: location.path,
        tone: 'ready'
      }
    case 'no-project':
      return {
        label: translate('workspace.location.home', 'Home folder'),
        detail: translate('workspace.location.homeDetail', 'This agent has no project.'),
        tone: 'neutral'
      }
    case 'unresolved':
      return {
        label: translate('workspace.location.unresolved', 'Project unavailable'),
        detail: translate(
          'workspace.location.unresolvedDetail',
          'Its project has no setup Orca can find. Turns are refused until it returns.'
        ),
        tone: 'refused'
      }
    case 'not-ready':
      return {
        label: (SETUP_STATE_LABEL[location.setupState] ?? (() => location.setupState))(),
        detail: translate(
          'workspace.location.notReadyDetail',
          'Turns are refused until the project is ready on this computer.'
        ),
        tone: 'caution'
      }
    case 'remote-host':
      return {
        label: translate('workspace.location.remote', 'Remote host'),
        detail: translate(
          'workspace.location.remoteDetail',
          '{{host}} — agent chats cannot run on a remote host yet, so turns are refused.',
          { host: location.hostId }
        ),
        tone: 'refused'
      }
  }
}

export function describeProvider(provider: AgentGroundingProvider): {
  driver: string
  credential: GroundingFact
} {
  return {
    driver: translate('workspace.provider.codex', 'Codex (app server)'),
    credential:
      provider.credential.state === 'ready'
        ? {
            label: translate('workspace.credential.ready', 'Signed in'),
            detail: null,
            tone: 'ready'
          }
        : {
            label: translate('workspace.credential.notReady', 'Sign-in required'),
            detail: provider.credential.detail,
            tone: 'caution'
          }
  }
}
