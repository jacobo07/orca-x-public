// The transient half of a conversation: what is happening right now, which is NOT what is stored.
//
// The durable record carries settled messages. This carries the sentence currently being typed by
// the model, the provider's status line, and how the last turn ended. Keeping them apart is why a
// crash can never leave a half-sentence in the user's history, and why reopening a conversation
// shows what was actually said rather than a frozen stream.
//
// This module owns no COPY. A notice is a kind plus the provider's own detail; the component turns
// that into a translated sentence. Holding English here would make the state untestable without
// asserting on prose, and would put user-facing text outside the localization catalogue.

import type { AgentTurnEvent } from '../../../../shared/agent-turn-event'
import type { ConversationTurnOutcome } from '../../../../shared/conversation-turn'
import type { ConversationForAgentResult } from '../../../../shared/conversation-types'

export type ConversationNoticeKind =
  | 'auth-required'
  | 'busy'
  | 'failed'
  | 'interrupted'
  | 'not-durable'
  | 'absent'
  | 'agent-missing'
  | 'agent-unverifiable'
  | 'approval-declined'
  /** Ways an agent's project cannot be reached, kept apart because each is a different action: set
   *  it up, wait for its setup, open it where it lives, choose one host, or run where it lives. */
  | 'project-not-set-up'
  | 'project-setup-incomplete'
  | 'project-remote-only'
  | 'project-host-ambiguous'
  | 'project-remote-execution-unavailable'
  | 'project-remote-host-unreachable'
  | 'project-remote-relay-unsupported'
  | 'project-remote-missing'
  | 'project-location-changed'
  | 'provider-not-installed'
  | 'provider-protocol-unsupported'
  | 'failed-timed-out'
  | 'failed-host-lost'

export type ConversationNotice = {
  kind: ConversationNoticeKind
  /** The provider's or the store's own words, passed through untranslated — it is evidence, and
   *  inventing a friendlier version of it would hide what actually happened. Null when there is
   *  nothing to quote. */
  detail: string | null
  /** True when the user's message is in the record even though no answer is, so the surface keeps
   *  showing what they typed instead of clearing as though nothing happened. */
  userMessageKept: boolean
}

export type ConversationLiveState = {
  /** Deltas accumulated for the assistant message still being written, keyed by provider item id.
   *  Cleared when that item settles, because the settled version comes from the record. */
  streamingByItemId: Record<string, string>
  turnState: 'idle' | 'working'
  /** Provider-reported status, e.g. `waitingOnApproval`. Null when it has said nothing. */
  status: string | null
  notice: ConversationNotice | null
}

export const EMPTY_CONVERSATION_LIVE_STATE: ConversationLiveState = {
  streamingByItemId: {},
  turnState: 'idle',
  status: null,
  notice: null
}

export function beginConversationTurn(state: ConversationLiveState): ConversationLiveState {
  return { ...state, turnState: 'working', notice: null, streamingByItemId: {} }
}

export function applyConversationLiveEvent(
  state: ConversationLiveState,
  event: AgentTurnEvent
): ConversationLiveState {
  switch (event.kind) {
    case 'turn-started':
      return { ...state, turnState: 'working', notice: null }
    case 'assistant-delta':
      return {
        ...state,
        streamingByItemId: {
          ...state.streamingByItemId,
          [event.itemId]: (state.streamingByItemId[event.itemId] ?? '') + event.text
        }
      }
    case 'message-completed': {
      // The settled message is about to arrive from the record. Dropping the stream here is what
      // stops the same sentence being shown twice, once live and once durable.
      const { [event.itemId]: _settled, ...rest } = state.streamingByItemId
      return { ...state, streamingByItemId: rest }
    }
    case 'turn-completed':
      return { ...state, turnState: 'idle', status: null, streamingByItemId: {} }
    case 'turn-ended':
      return {
        ...state,
        turnState: 'idle',
        status: null,
        streamingByItemId: {},
        notice: {
          kind: event.state === 'failed' ? 'failed' : 'interrupted',
          detail: event.reason,
          userMessageKept: true
        }
      }
    case 'provider-status':
      return { ...state, status: event.detail ?? event.status }
    case 'approval-requested':
      // Honest about what Orca did, rather than leaving a turn looking stuck: W2 ships no decider,
      // so the request is refused and the command does not run.
      return {
        ...state,
        notice: { kind: 'approval-declined', detail: event.summary, userMessageKept: true }
      }
    case 'approval-resolved':
    case 'unmapped':
      return state
  }
}

export function noticeForTurnOutcome(outcome: ConversationTurnOutcome): ConversationNotice | null {
  switch (outcome.outcome) {
    case 'completed':
      return null
    case 'busy':
      return { kind: 'busy', detail: null, userMessageKept: false }
    case 'auth-required':
      // Never rendered as an assistant message: a 401 is not a conversation.
      return { kind: 'auth-required', detail: outcome.detail, userMessageKept: true }
    case 'provider-unavailable':
      return {
        kind:
          outcome.reason === 'not-installed'
            ? 'provider-not-installed'
            : 'provider-protocol-unsupported',
        detail: outcome.detail,
        userMessageKept: true
      }
    case 'not-durable':
      return { kind: 'not-durable', detail: outcome.reason, userMessageKept: true }
    case 'failed':
      return {
        kind:
          outcome.cause === 'timed-out'
            ? 'failed-timed-out'
            : outcome.cause === 'host-lost'
              ? 'failed-host-lost'
              : 'failed',
        detail: outcome.reason,
        userMessageKept: true
      }
    case 'conversation-absent':
      return { kind: 'absent', detail: null, userMessageKept: false }
    case 'agent-unavailable':
      // Refused before anything was committed or sent. No id in the notice: that is machinery.
      return {
        kind: outcome.reason === 'missing' ? 'agent-missing' : 'agent-unverifiable',
        detail: null,
        userMessageKept: false
      }
    case 'project-unavailable':
      // Also refused before anything was committed or sent.
      return projectNotice(outcome.reason, outcome.detail)
  }
}

/** The three reasons stay apart all the way to the sentence: set the project up, wait for its
 *  setup to finish, or open it where it lives. The setup state is quoted as evidence; a project id
 *  and a path are machinery and stay out of the notice. */
function projectNotice(
  reason: Extract<ConversationTurnOutcome, { outcome: 'project-unavailable' }>['reason'],
  detail: string
): ConversationNotice {
  switch (reason) {
    case 'unresolved':
      return { kind: 'project-not-set-up', detail: null, userMessageKept: false }
    case 'not-ready':
      return { kind: 'project-setup-incomplete', detail, userMessageKept: false }
    case 'remote-host':
      return { kind: 'project-remote-only', detail: null, userMessageKept: false }
    case 'ambiguous-host':
      return { kind: 'project-host-ambiguous', detail: null, userMessageKept: false }
    case 'remote-execution-unavailable':
      return { kind: 'project-remote-execution-unavailable', detail: null, userMessageKept: false }
    case 'remote-host-unreachable':
      return { kind: 'project-remote-host-unreachable', detail: null, userMessageKept: false }
    case 'remote-relay-unsupported':
      return { kind: 'project-remote-relay-unsupported', detail: null, userMessageKept: false }
    case 'remote-project-missing':
      return { kind: 'project-remote-missing', detail: null, userMessageKept: false }
    case 'location-changed':
      return { kind: 'project-location-changed', detail: null, userMessageKept: false }
  }
}

/** A refused agent-bound create: nothing was minted, and the typed message stays in the composer. */
export function noticeForAgentCreateRefusal(
  result: Exclude<ConversationForAgentResult, { outcome: 'created' }>
): ConversationNotice {
  return {
    kind: result.outcome === 'agent-not-found' ? 'agent-missing' : 'agent-unverifiable',
    detail: null,
    userMessageKept: false
  }
}

export function applyConversationTurnOutcome(
  state: ConversationLiveState,
  outcome: ConversationTurnOutcome
): ConversationLiveState {
  return {
    ...state,
    turnState: 'idle',
    status: null,
    streamingByItemId: {},
    notice: noticeForTurnOutcome(outcome)
  }
}
