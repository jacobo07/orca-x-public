// One sentence per way a turn is refused before anything is committed. A caller that only had
// "project unavailable" would send someone to look at the wrong thing in most cases.

import type { ConversationTurnOutcome } from '../../shared/conversation-turn'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'

import type { AgentProjectLocation } from './agent-project-location'

/** Why a remote host could not take a turn. Each has its own fix: reconnect the host, update Orca
 *  on it, or set the project up again. */
export type RemoteDriverRefusal =
  | 'remote-host-unreachable'
  | 'remote-relay-unsupported'
  | 'remote-project-missing'

/** Keyed by every refusal, so a new one cannot fall into another's sentence. */
export const REMOTE_REFUSAL_DETAIL: Record<RemoteDriverRefusal, string> = {
  'remote-host-unreachable': 'This agent’s remote host is not connected.',
  'remote-relay-unsupported': 'Orca on this agent’s remote host is too old to run a chat there.',
  'remote-project-missing': 'This agent’s project directory is not on its remote host.'
}

type RefusingLocation = Extract<
  AgentProjectLocation,
  { outcome: 'unresolved' | 'not-ready' | 'remote-host' | 'ambiguous-host' }
>
type ProjectUnavailable = Extract<ConversationTurnOutcome, { outcome: 'project-unavailable' }>

export function describeUnavailableProject(location: RefusingLocation): ProjectUnavailable {
  const refuse = (reason: ProjectUnavailable['reason'], detail: string): ProjectUnavailable => ({
    outcome: 'project-unavailable',
    projectId: location.projectId,
    reason,
    detail
  })
  switch (location.outcome) {
    case 'unresolved':
      return refuse('unresolved', 'This agent’s project is not set up on this computer.')
    case 'not-ready':
      return refuse(
        'not-ready',
        location.hostId === LOCAL_EXECUTION_HOST_ID
          ? `This agent’s project is ${location.setupState} on this computer.`
          : `This agent’s project is ${location.setupState} on a remote host.`
      )
    case 'ambiguous-host':
      return refuse(
        'ambiguous-host',
        `This agent’s project is set up on ${location.hostIds.length} remote hosts, and Orca will not pick one for it.`
      )
    case 'remote-host':
      return refuse(
        'remote-host',
        'This agent’s project lives on a kind of host a chat cannot run on yet.'
      )
  }
}
