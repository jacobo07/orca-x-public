import { translate } from '@/i18n/i18n'
import type {
  ConfirmationDialogContextValue,
  ConfirmationDialogOptions
} from '@/components/confirmation-dialog-context'
import type {
  LiveAgentSessionPresenceRequest,
  LiveAgentSessionPresenceResponse,
  LiveSessionMaterializationRequest,
  LiveSessionMaterializationResponse
} from '../../../shared/live-agent-session-presence-types'
import {
  isResumableTuiAgent,
  type AgentProviderSessionMetadata
} from '../../../shared/agent-session-resume'

/** `materialization` names the operation to attach the new tab to; null when the gate did
 *  not run. Attaching is a no-op when main granted without reserving. */
export type LiveSessionCollisionGateResult =
  | { outcome: 'proceed'; materialization: { operationId: string } | null }
  | { outcome: 'cancelled' }

type Reserve = (
  request: LiveSessionMaterializationRequest
) => Promise<LiveSessionMaterializationResponse>

// Why: owners that keep changing under an open dialog end in refusal, not an endless loop.
const MAX_CONFIRMATION_ROUNDS = 3

const UNREADABLE: LiveSessionMaterializationResponse = {
  outcome: 'blocked',
  presence: {
    kind: 'unknown',
    liveElsewhere: [],
    ownersRevision: '',
    unknownCount: 0,
    staleCount: 0
  }
}

function collisionDialog(presence: LiveAgentSessionPresenceResponse): ConfirmationDialogOptions {
  const labels = {
    cancelLabel: translate('agentSession.liveCollision.back', 'Back'),
    confirmLabel: translate('agentSession.liveCollision.continue', 'Continue')
  }
  const risk = translate(
    'agentSession.liveCollision.continueRisk',
    "Continuing opens a second live copy. Orca can't guarantee both copies work correctly at the same time."
  )
  if (presence.kind === 'materializing') {
    // Why: the other attempt has not started yet, so "already open" would be false.
    return {
      ...labels,
      title: translate(
        'agentSession.liveCollision.startingTitle',
        'This session is already starting'
      ),
      description: `${translate(
        'agentSession.liveCollision.startingDescription',
        'Another resume of it is still opening.'
      )} ${risk}`
    }
  }
  if (presence.kind === 'unknown') {
    return {
      ...labels,
      title: translate(
        'agentSession.liveCollision.unknownTitle',
        'This session may already be open'
      ),
      description: `${translate(
        'agentSession.liveCollision.unknownDescription',
        'Orca could not confirm whether it is active in another pane.'
      )} ${risk}`
    }
  }
  const where =
    presence.kind === 'multiple-live-owners'
      ? translate(
          'agentSession.liveCollision.activeInPanes',
          'It is already active in {{count}} other panes.',
          { count: presence.liveElsewhere.length }
        )
      : translate(
          'agentSession.liveCollision.activeInPane',
          'It is already active in another pane.'
        )
  return {
    ...labels,
    title: translate('agentSession.liveCollision.title', 'This session is already open'),
    description: `${where} ${risk}`
  }
}

async function reserveOrUnknown(
  reserve: Reserve,
  request: LiveSessionMaterializationRequest
): Promise<LiveSessionMaterializationResponse> {
  try {
    return await reserve(request)
  } catch {
    // Why: an unanswered question is uncertainty; reading it as a grant would skip the guard.
    return UNREADABLE
  }
}

/** Gate for a resume Orca itself selected. A runtime-routed launch is left to its host's
 *  claim registry, and a launch without an exact resumable identity has nothing to check. */
export function gateOrcaSelectedResume(args: {
  worktreeId: string
  agent: string
  providerSession?: AgentProviderSessionMetadata
  launchesThroughRuntime: boolean
  confirm: ConfirmationDialogContextValue | null
}): Promise<LiveSessionCollisionGateResult> {
  if (!args.providerSession || !isResumableTuiAgent(args.agent) || args.launchesThroughRuntime) {
    return Promise.resolve({ outcome: 'proceed', materialization: null })
  }
  return gateLiveSessionMaterialization({
    request: {
      worktreeId: args.worktreeId,
      agent: args.agent,
      providerSession: args.providerSession
    },
    reserve: (request) => window.api.agentStatus.reserveMaterialization(request),
    confirm: args.confirm,
    operationId: crypto.randomUUID()
  })
}

/** Decides whether an Orca-selected resume may materialize. Main grants at most one
 *  unoverridden attempt per session; the user is asked only when a live owner, an
 *  in-progress attempt or uncertainty stands in the way. Continue sends back exactly
 *  the collision it answered, and main grants it only if that is still the collision.
 *  Nothing is stored: every attempt asks afresh. */
export async function gateLiveSessionMaterialization(args: {
  request: LiveAgentSessionPresenceRequest
  reserve: Reserve
  confirm: ConfirmationDialogContextValue | null
  operationId: string
}): Promise<LiveSessionCollisionGateResult> {
  const base = { ...args.request, operationId: args.operationId }
  const proceed = (): LiveSessionCollisionGateResult => ({
    outcome: 'proceed',
    materialization: { operationId: args.operationId }
  })
  let observed = await reserveOrUnknown(args.reserve, base)
  if (observed.outcome === 'granted') {
    return proceed()
  }
  for (let round = 0; round < MAX_CONFIRMATION_ROUNDS; round += 1) {
    if (!args.confirm || !(await args.confirm(collisionDialog(observed.presence)))) {
      return { outcome: 'cancelled' }
    }
    const current = await reserveOrUnknown(args.reserve, {
      ...base,
      accept: { kind: observed.presence.kind, ownersRevision: observed.presence.ownersRevision }
    })
    if (current.outcome === 'granted') {
      return proceed()
    }
    // Why: Continue answered the question the user saw; a different collision is a different question.
    observed = current
  }
  return { outcome: 'cancelled' }
}
