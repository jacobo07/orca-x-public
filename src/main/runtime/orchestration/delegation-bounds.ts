// Structural bounds on agent-to-agent delegation. Prompts cannot bound recursion; this does, at the
// one place every task is created. Terminal-created tasks keep their historical, unbounded shape.

/** Deepest ancestry an agent-assigned task may have (root mission = depth 0). */
export const MAX_DELEGATION_DEPTH = 6
/** Children one task may delegate; bounds fan-out storms. */
export const MAX_DELEGATION_FAN_OUT = 12

export type DelegationRefusal =
  | { code: 'delegation-depth-exceeded'; depth: number; max: number }
  | { code: 'delegation-fan-out-exceeded'; children: number; max: number }
  | { code: 'delegation-cycle'; agentId: string }
  | { code: 'delegation-requester-not-holder'; requesterAgentId: string; holderAgentId: string | null }
  | { code: 'delegation-requires-parent'; requesterAgentId: string }

export type DelegationAncestor = { assigneeAgentId: string | null }

export type DelegationRequest = {
  assigneeAgentId: string | null
  requesterAgentId: string | null
  /** Nearest first: [parent, grandparent, ...]. */
  ancestors: readonly DelegationAncestor[]
  parentChildCount: number
}

export class DelegationRefusedError extends Error {
  constructor(readonly refusal: DelegationRefusal) {
    super(`Delegation refused: ${refusal.code}`)
    this.name = 'DelegationRefusedError'
  }
}

export function judgeDelegation(request: DelegationRequest): DelegationRefusal | null {
  const { assigneeAgentId, requesterAgentId, ancestors } = request
  if (requesterAgentId !== null) {
    // Why: an agent may only split work it holds; a root mission is a human act.
    const parent = ancestors[0]
    if (!parent) {
      return { code: 'delegation-requires-parent', requesterAgentId }
    }
    if (parent.assigneeAgentId !== requesterAgentId) {
      return {
        code: 'delegation-requester-not-holder',
        requesterAgentId,
        holderAgentId: parent.assigneeAgentId
      }
    }
  }
  if (assigneeAgentId === null) {
    return null
  }
  if (ancestors.length > MAX_DELEGATION_DEPTH) {
    return { code: 'delegation-depth-exceeded', depth: ancestors.length, max: MAX_DELEGATION_DEPTH }
  }
  if (ancestors.length > 0 && request.parentChildCount >= MAX_DELEGATION_FAN_OUT) {
    return {
      code: 'delegation-fan-out-exceeded',
      children: request.parentChildCount,
      max: MAX_DELEGATION_FAN_OUT
    }
  }
  if (ancestors.some((ancestor) => ancestor.assigneeAgentId === assigneeAgentId)) {
    return { code: 'delegation-cycle', agentId: assigneeAgentId }
  }
  return null
}
