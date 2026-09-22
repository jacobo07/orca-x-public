// Agent identity, and what may not contribute to it.
//
// Mirrors conversation-identity.ts deliberately: no mint function takes a project id, conversation
// id, display name, provider, provider session or pane. An id derived from any of those inherits
// that thing's lifetime — and the whole reason this entity exists is to outlive all of them.

import { AGENT_ID_PREFIX, type Agent, type AgentId } from './agent-types'

/** Same cross-process pattern as conversation ids: crypto where it exists, and a fallback that
 *  keeps Node 18 SSH companions working. */
function randomIdSuffix(): string {
  const randomUUID = globalThis.crypto?.randomUUID
  if (randomUUID) {
    return randomUUID.call(globalThis.crypto)
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Takes no arguments, on purpose. */
export function mintAgentId(): AgentId {
  return `${AGENT_ID_PREFIX}${randomIdSuffix()}`
}

export function isAgentId(value: unknown): value is AgentId {
  return (
    typeof value === 'string' &&
    value.startsWith(AGENT_ID_PREFIX) &&
    value.length > AGENT_ID_PREFIX.length
  )
}

/** Refuses rather than repairs, like the conversation reader: an agent whose id or ownership
 *  cannot be read is not an agent with a blank name, and defaulting one would silently reassign
 *  somebody's actor to no project. */
export function isAgent(value: unknown): value is Agent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return (
    isAgentId(candidate.id) &&
    typeof candidate.name === 'string' &&
    typeof candidate.role === 'string' &&
    (candidate.projectId === null || typeof candidate.projectId === 'string') &&
    Number.isFinite(candidate.createdAt) &&
    Number.isFinite(candidate.updatedAt)
  )
}
