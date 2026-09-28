// The provider-neutral turn vocabulary the Cognitive Workspace consumes.
//
// This is NOT a second content model. Roles and blocks are the existing shared native-chat types,
// so a normalized event carries exactly what a conversation record stores and a transcript
// renders — no translation layer, no drift between the two.
//
// Every variant here has a real producer and a real consumer. The Codex mapping emits them from
// notification names observed on the wire; a name nobody has seen becomes `unmapped`, which is a
// diagnostic and never product state.

import type { NativeChatBlock, NativeChatRole } from './native-chat-types'

export type AgentTurnEvent =
  | { kind: 'turn-started'; turnId: string }
  /** Incremental assistant text. `itemId` groups deltas into the message they build. */
  | { kind: 'assistant-delta'; turnId: string | null; itemId: string; text: string }
  /** A completed item, with the blocks a conversation record would store. */
  | { kind: 'message-completed'; turnId: string | null; itemId: string; role: NativeChatRole; blocks: NativeChatBlock[] }
  | { kind: 'turn-completed'; turnId: string }
  /** The turn ended without completing. `interrupted` and `failed` are different records. */
  | { kind: 'turn-ended'; turnId: string | null; state: 'interrupted' | 'failed'; reason: string }
  /** Provider-side condition worth showing, e.g. waiting on an approval. Not durable content. */
  | { kind: 'provider-status'; status: string; detail: string | null }
  | { kind: 'approval-requested'; approvalId: string; method: string; summary: string }
  | { kind: 'approval-resolved'; approvalId: string; approved: boolean; reason: string }
  /** A provider message this build does not model. Carries no product meaning by design. */
  | { kind: 'unmapped'; method: string }

/** What a provider driver can actually do. Three states, because a capability nobody has verified
 *  is not the same as one the provider lacks — UNSUPPORTED is a claim, UNKNOWN is the absence of
 *  one, and only UNSUPPORTED justifies hiding a feature. */
export type AgentCapabilitySupport = 'supported' | 'unsupported' | 'unknown'

export type AgentProviderCapability =
  | 'streaming-deltas'
  | 'persistent-session'
  | 'thread-resume'
  | 'server-requests'
  | 'tool-approvals'
  | 'cancellation'

export type AgentProviderCapabilities = Record<AgentProviderCapability, AgentCapabilitySupport>

/** Everything unknown. A driver states what it has PROVEN, and silence stays silence. */
export const UNKNOWN_AGENT_CAPABILITIES: AgentProviderCapabilities = {
  'streaming-deltas': 'unknown',
  'persistent-session': 'unknown',
  'thread-resume': 'unknown',
  'server-requests': 'unknown',
  'tool-approvals': 'unknown',
  cancellation: 'unknown'
}
