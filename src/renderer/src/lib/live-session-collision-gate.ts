import { translate } from '@/i18n/i18n'
import type {
  ConfirmationDialogContextValue,
  ConfirmationDialogOptions
} from '@/components/confirmation-dialog-context'
import type {
  LiveAgentSessionPresenceRequest,
  LiveAgentSessionPresenceResponse
} from '../../../shared/live-agent-session-presence-types'
import {
  isResumableTuiAgent,
  type AgentProviderSessionMetadata
} from '../../../shared/agent-session-resume'

export type LiveSessionCollisionGateOutcome = 'proceed' | 'cancelled'

// Why: owners that keep changing under an open dialog end in refusal, not an endless loop.
const MAX_CONFIRMATION_ROUNDS = 3

const UNREADABLE: LiveAgentSessionPresenceResponse = {
  kind: 'unknown',
  liveElsewhere: [],
  ownersRevision: '',
  unknownCount: 0,
  staleCount: 0
}

function isClear(presence: LiveAgentSessionPresenceResponse): boolean {
  return presence.kind === 'no-live-owner' || presence.kind === 'live-here'
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

async function readOrUnknown(
  readPresence: (
    request: LiveAgentSessionPresenceRequest
  ) => Promise<LiveAgentSessionPresenceResponse>,
  request: LiveAgentSessionPresenceRequest
): Promise<LiveAgentSessionPresenceResponse> {
  try {
    return await readPresence(request)
  } catch {
    // Why: an unanswered question is uncertainty; reading it as "no owner" would skip the guard.
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
}): Promise<LiveSessionCollisionGateOutcome> {
  if (!args.providerSession || !isResumableTuiAgent(args.agent) || args.launchesThroughRuntime) {
    return Promise.resolve('proceed')
  }
  return gateLiveSessionMaterialization({
    request: {
      worktreeId: args.worktreeId,
      agent: args.agent,
      providerSession: args.providerSession
    },
    readPresence: (request) => window.api.agentStatus.readLivePresence(request),
    confirm: args.confirm
  })
}

/** Decides whether an Orca-selected resume may materialize. Asks only when a live owner is
 *  proven or cannot be ruled out, revalidates after Continue, and stores nothing: every
 *  attempt asks afresh. */
export async function gateLiveSessionMaterialization(args: {
  request: LiveAgentSessionPresenceRequest
  readPresence: (
    request: LiveAgentSessionPresenceRequest
  ) => Promise<LiveAgentSessionPresenceResponse>
  confirm: ConfirmationDialogContextValue | null
}): Promise<LiveSessionCollisionGateOutcome> {
  let observed = await readOrUnknown(args.readPresence, args.request)
  if (isClear(observed)) {
    return 'proceed'
  }
  for (let round = 0; round < MAX_CONFIRMATION_ROUNDS; round += 1) {
    if (!args.confirm || !(await args.confirm(collisionDialog(observed)))) {
      return 'cancelled'
    }
    const current = await readOrUnknown(args.readPresence, args.request)
    if (isClear(current)) {
      return 'proceed'
    }
    // Why: Continue answered the question the user saw; a different owner is a different question.
    if (current.kind === observed.kind && current.ownersRevision === observed.ownersRevision) {
      return 'proceed'
    }
    observed = current
  }
  return 'cancelled'
}
