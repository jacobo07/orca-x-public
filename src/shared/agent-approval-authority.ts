// What a provider may ask Orca to allow, and who decides.
//
// PROVIDER ASKS ≠ ORCA APPROVES. A model requesting a command is untrusted intent; the decision is
// Orca's and belongs to whatever authority the product gives the user. Nothing here approves
// anything: the authority's job is to route a request to a decider and, when there is no decider,
// to refuse.

/** What the provider is asking for. `unknown` is a first-class member: a provider release that
 *  adds a request type must land here rather than in a permissive default. */
export type AgentApprovalKind =
  | 'command-execution'
  | 'file-change'
  | 'permissions'
  | 'user-input'
  | 'tool-call'
  | 'unknown'

export type AgentApprovalRequest = {
  /** Orca-minted, so a decision can be correlated without handing the provider's id to the UI. */
  approvalId: string
  /** The provider's own request id, echoed back verbatim when the answer is sent. */
  providerRequestId: string
  kind: AgentApprovalKind
  /** The provider's method name, kept for provenance and diagnostics. */
  method: string
  params: unknown
}

/** Who decided. `no-authority` is not a decider — it records that nobody could decide, which is
 *  why the request was refused. Collapsing it into `policy` would report a deliberate denial. */
export type AgentApprovalDecidedBy = 'user' | 'policy' | 'no-authority'

export type AgentApprovalDecision =
  | { decision: 'approved'; decidedBy: Exclude<AgentApprovalDecidedBy, 'no-authority'> }
  | { decision: 'denied'; decidedBy: AgentApprovalDecidedBy; reason: string }

/** The product's decision surface. W2 ships no implementation on purpose: until a user can see and
 *  answer a request, the only honest answer is a refusal. */
export type AgentApprovalDecider = (
  request: AgentApprovalRequest
) => Promise<AgentApprovalDecision>

export type AgentApprovalAuthority = {
  decide: (request: AgentApprovalRequest) => Promise<AgentApprovalDecision>
}

export const NO_APPROVAL_AUTHORITY_REASON =
  'no approval authority is available to decide this request'

/**
 * Wraps a decider so the refusal path cannot be forgotten. Absent decider, an unknown request kind
 * and a decider that throws all deny — a provider must never be able to turn Orca's inability to
 * decide into permission.
 */
export function createAgentApprovalAuthority(
  decider?: AgentApprovalDecider
): AgentApprovalAuthority {
  return {
    async decide(request) {
      if (request.kind === 'unknown') {
        // A request Orca does not model cannot be presented to a user accurately, so there is
        // nothing anyone could meaningfully approve.
        return {
          decision: 'denied',
          decidedBy: 'policy',
          reason: `orca does not model ${request.method}`
        }
      }
      if (!decider) {
        return {
          decision: 'denied',
          decidedBy: 'no-authority',
          reason: NO_APPROVAL_AUTHORITY_REASON
        }
      }
      try {
        return await decider(request)
      } catch (error) {
        return {
          decision: 'denied',
          decidedBy: 'no-authority',
          reason: `the approval decider failed: ${(error as Error)?.message ?? 'unknown'}`
        }
      }
    }
  }
}
