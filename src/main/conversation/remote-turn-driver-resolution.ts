// Resolves the driver a remote project's turn runs on, or the refusal that stops it BEFORE admission.
//
// A remote project's turn runs ON its host or not at all. With no driver for that host this is a
// refusal that commits nothing — never the local driver, and never a local directory of any name.

import type { Agent } from '../../shared/agent-types'
import type { AgentProjectLocation } from './agent-project-location'
import type {
  AuthCheck,
  ConversationTurnDeps,
  ConversationTurnDriver,
  ConversationTurnOutcome,
  RemoteDriverResolution
} from './conversation-turn-runner'
import { REMOTE_REFUSAL_DETAIL } from './conversation-turn-refusals'
import type { ConversationTurnTraceDraft } from './conversation-turn-trace'

type ResolvedRemoteLocation = Extract<AgentProjectLocation, { outcome: 'resolved-remote' }>
type ProjectUnavailableReason = Extract<
  ConversationTurnOutcome,
  { outcome: 'project-unavailable' }
>['reason']

export type RemoteTurnDriverChoice =
  | { driver: ConversationTurnDriver; checkAuth: AuthCheck; hostAddress: string | null }
  | { refused: ConversationTurnOutcome }

export async function resolveRemoteTurnDriver(
  deps: Pick<ConversationTurnDeps, 'remoteDriverFor' | 'resolveProjectLocation'>,
  agent: Agent | null,
  location: ResolvedRemoteLocation,
  trace: ConversationTurnTraceDraft
): Promise<RemoteTurnDriverChoice> {
  const target = {
    projectId: location.projectId,
    hostId: location.hostId,
    setupId: location.setupId,
    path: location.path
  }
  // Known before the host is asked, so a refusal still says where it tried.
  Object.assign(trace, { hostId: target.hostId, setupId: target.setupId, path: target.path })
  const refuse = (reason: ProjectUnavailableReason, detail: string): RemoteTurnDriverChoice => ({
    refused: { outcome: 'project-unavailable', projectId: location.projectId, reason, detail }
  })
  if (!deps.remoteDriverFor) {
    return refuse(
      'remote-execution-unavailable',
      'This agent’s project lives on a remote host, and Orca cannot run its chat there.'
    )
  }
  let resolution: RemoteDriverResolution
  try {
    resolution = await deps.remoteDriverFor(target)
  } catch {
    // Nothing escapes before admission: a probe that threw is a host we could not reach.
    resolution = { refusal: 'remote-host-unreachable' }
  }
  if ('refusal' in resolution) {
    return refuse(resolution.refusal, REMOTE_REFUSAL_DETAIL[resolution.refusal])
  }
  // The probe awaited; a project that moved meanwhile must not run at the location read before.
  const again = agent ? deps.resolveProjectLocation(agent) : null
  if (
    again?.outcome !== 'resolved-remote' ||
    again.hostId !== target.hostId ||
    again.setupId !== target.setupId ||
    again.path !== target.path
  ) {
    return refuse(
      'location-changed',
      'This agent’s project moved while the message was being sent.'
    )
  }
  return {
    driver: resolution.driver,
    checkAuth: resolution.checkAuth,
    hostAddress: resolution.hostAddress ?? null
  }
}
