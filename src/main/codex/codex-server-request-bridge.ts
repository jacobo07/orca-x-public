// The one path a Codex server→client request takes to reach an answer.
//
// Fails closed at every step, because the alternative to a refusal here is an effect nobody
// authorized: `item/tool/call` asks the client to EXECUTE a tool, and the approval family asks
// permission to run commands and write files.

import type {
  AgentApprovalAuthority,
  AgentApprovalRequest
} from '../../shared/agent-approval-authority'
import type { CodexServerRequestOutcome } from './codex-app-server-inbound-router'
import { classifyCodexServerRequest } from './codex-server-request-classification'
import { renderCodexApprovalOutcome } from './codex-approval-response-shape'
import type {
  ProviderTurnTool,
  ProviderTurnToolResult
} from '../conversation/provider-turn-tool'

const JSON_RPC_METHOD_NOT_FOUND = -32601

export type CodexServerRequestObservation =
  | { event: 'approval-requested'; request: AgentApprovalRequest }
  | { event: 'approval-resolved'; approvalId: string; approved: boolean; reason: string }
  | { event: 'refused'; method: string; reason: string }
  | { event: 'tool-called'; tool: string; success: boolean }

export type CodexServerRequestBridge = {
  handle: (request: {
    id: number | string
    method: string
    params: unknown
  }) => Promise<CodexServerRequestOutcome>
}

export function createCodexServerRequestBridge(options: {
  authority: AgentApprovalAuthority
  /** Orca-minted approval ids, injected so a test does not depend on randomness. */
  mintApprovalId: () => string
  /** Product-visible record of what was asked and what was decided. */
  observe?: (observation: CodexServerRequestObservation) => void
  /** The tools this turn declared. `item/tool/call` for any other name is refused. */
  tools?: readonly ProviderTurnTool[]
}): CodexServerRequestBridge {
  const observe = (observation: CodexServerRequestObservation): void => {
    try {
      options.observe?.(observation)
    } catch {
      // An observer must not be able to turn a refusal into a crash mid-decision.
    }
  }

  return {
    async handle({ id, method, params }) {
      if (method === 'item/tool/call') {
        const call = params as { tool?: unknown; arguments?: unknown } | null
        const tool = options.tools?.find((candidate) => candidate.name === call?.tool)
        if (tool) {
          let result: ProviderTurnToolResult
          try {
            result = await tool.invoke(call?.arguments)
          } catch (error) {
            result = { success: false, text: error instanceof Error ? error.message : String(error) }
          }
          observe({ event: 'tool-called', tool: tool.name, success: result.success })
          return {
            outcome: 'result',
            result: { contentItems: [{ type: 'inputText', text: result.text }], success: result.success }
          }
        }
        // An undeclared tool falls through to the refusal below: declaring is the authorization.
      }

      const classified = classifyCodexServerRequest(method)

      if (classified.handling !== 'approval') {
        // Unimplemented services and unrecognised methods answer identically on the wire, but they
        // are different facts and the diagnostic keeps them apart.
        const reason =
          classified.handling === 'unimplemented-service'
            ? `orca does not implement ${method}`
            : `orca does not recognise ${method}`
        observe({ event: 'refused', method, reason })
        return { outcome: 'error', code: JSON_RPC_METHOD_NOT_FOUND, message: reason }
      }

      const approvalRequest: AgentApprovalRequest = {
        approvalId: options.mintApprovalId(),
        providerRequestId: String(id),
        kind: classified.kind,
        method,
        params
      }
      observe({ event: 'approval-requested', request: approvalRequest })

      const decision = await options.authority.decide(approvalRequest)
      const approved = decision.decision === 'approved'
      const reason = approved ? `approved by ${decision.decidedBy}` : decision.reason
      observe({ event: 'approval-resolved', approvalId: approvalRequest.approvalId, approved, reason })

      return renderCodexApprovalOutcome(method, approved, reason)
    }
  }
}
