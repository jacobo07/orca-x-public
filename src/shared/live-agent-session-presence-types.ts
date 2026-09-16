import {
  isResumableTuiAgent,
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata,
  type ResumableTuiAgent
} from './agent-session-resume'
import { parsePaneKey } from './stable-pane-id'

export const LIVE_AGENT_SESSION_PRESENCE_CHANNEL = 'agentSession:readLivePresence'
export const LIVE_SESSION_COLLISION_CHANNEL = 'agentSession:liveCollision'

export type LiveSessionCollisionNotice = {
  /** Pane that just started reporting a session already live elsewhere. */
  paneKey: string
  kind: 'live-elsewhere' | 'multiple-live-owners'
  liveElsewhere: string[]
}

export type LiveAgentSessionPresenceRequest = {
  /** Pane about to materialize the session; absent when the pane does not exist yet. */
  paneKey?: string
  worktreeId: string
  agent: ResumableTuiAgent
  providerSession: AgentProviderSessionMetadata
}

export type LiveAgentSessionPresenceWireKind =
  | 'no-live-owner'
  | 'live-here'
  | 'live-elsewhere'
  | 'multiple-live-owners'
  | 'unknown'
  /** Another Orca operation is starting this session; it is not live yet. */
  | 'materializing'

/** Renderer-facing answer. Carries pane keys, never provider identifiers. */
export type LiveAgentSessionPresenceResponse = {
  kind: LiveAgentSessionPresenceWireKind
  liveElsewhere: string[]
  /** Changes whenever the set of live owners or the runtime behind any of them changes. */
  ownersRevision: string
  unknownCount: number
  staleCount: number
}

export const LIVE_SESSION_MATERIALIZATION_RESERVE_CHANNEL = 'agentSession:reserveMaterialization'
export const LIVE_SESSION_MATERIALIZATION_ATTACH_CHANNEL = 'agentSession:attachMaterializationTab'
export const LIVE_SESSION_MATERIALIZATION_RELEASE_CHANNEL = 'agentSession:releaseMaterialization'

export type LiveSessionMaterializationRequest = LiveAgentSessionPresenceRequest & {
  /** One per user intent; a retry of the same intent reuses it. */
  operationId: string
  /** The collision the user chose to continue past; granted only if it is still the same. */
  accept?: { kind: LiveAgentSessionPresenceWireKind; ownersRevision: string }
}

export type LiveSessionMaterializationResponse = {
  outcome: 'granted' | 'blocked'
  presence: LiveAgentSessionPresenceResponse
}

const MAX_WORKTREE_ID_LENGTH = 1024
const MAX_OPERATION_ID_LENGTH = 128
const MAX_OWNERS_REVISION_LENGTH = 65_536

export function isMaterializationOperationId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_OPERATION_ID_LENGTH
}

const WIRE_KINDS: readonly LiveAgentSessionPresenceWireKind[] = [
  'no-live-owner',
  'live-here',
  'live-elsewhere',
  'multiple-live-owners',
  'unknown',
  'materializing'
]

/** Null when the request cannot name one exact provider session and one operation. */
export function parseLiveSessionMaterializationRequest(
  value: unknown
): LiveSessionMaterializationRequest | null {
  const presence = parseLiveAgentSessionPresenceRequest(value)
  if (!presence) {
    return null
  }
  const raw = value as Record<string, unknown>
  if (!isMaterializationOperationId(raw.operationId)) {
    return null
  }
  if (raw.accept === undefined) {
    return { ...presence, operationId: raw.operationId }
  }
  const accept = raw.accept as Record<string, unknown> | null
  if (
    !accept ||
    typeof accept !== 'object' ||
    !WIRE_KINDS.includes(accept.kind as LiveAgentSessionPresenceWireKind) ||
    typeof accept.ownersRevision !== 'string' ||
    accept.ownersRevision.length > MAX_OWNERS_REVISION_LENGTH
  ) {
    return null
  }
  return {
    ...presence,
    operationId: raw.operationId,
    accept: {
      kind: accept.kind as LiveAgentSessionPresenceWireKind,
      ownersRevision: accept.ownersRevision
    }
  }
}

function isStablePaneKey(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && parsePaneKey(value) !== null
}

/** Null when the request cannot name one exact provider session. */
export function parseLiveAgentSessionPresenceRequest(
  value: unknown
): LiveAgentSessionPresenceRequest | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const raw = value as Record<string, unknown>
  if (
    (raw.paneKey !== undefined && !isStablePaneKey(raw.paneKey)) ||
    typeof raw.worktreeId !== 'string' ||
    raw.worktreeId.length === 0 ||
    raw.worktreeId.length > MAX_WORKTREE_ID_LENGTH ||
    !isResumableTuiAgent(raw.agent)
  ) {
    return null
  }
  const providerSession = normalizeAgentProviderSession(raw.providerSession)
  if (!providerSession) {
    return null
  }
  return {
    ...(typeof raw.paneKey === 'string' ? { paneKey: raw.paneKey } : {}),
    worktreeId: raw.worktreeId,
    agent: raw.agent,
    providerSession
  }
}
