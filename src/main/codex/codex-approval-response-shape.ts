// Renders an Orca approval decision into the wire shape the specific Codex method expects.
//
// There is no single "approval response". Read from the installed schema (codex-cli 0.153.4,
// 2026-09-21) the six approval requests answer in FOUR different vocabularies:
//
//   item/commandExecution/requestApproval -> { decision: accept | decline | cancel | ... }
//   item/fileChange/requestApproval       -> { decision: accept | decline | cancel | ... }
//   execCommandApproval, applyPatchApproval (legacy)
//                                         -> { decision: approved | denied | abort | ... }
//   item/permissions/requestApproval      -> { permissions: GrantedPermissionProfile }  (!)
//   item/tool/requestUserInput            -> { answers: { [id]: answer } }              (!)
//
// The last two have NO shape that expresses a refusal, and their success shape is a grant Orca
// would have to invent — a permission profile nobody chose, or answers no user gave. So they are
// refused at the protocol level instead, which is the one honest answer available.

import type { CodexServerRequestOutcome } from './codex-app-server-inbound-router'

const JSON_RPC_INTERNAL_ERROR = -32603

type ApprovalWireVocabulary = 'modern-decision' | 'legacy-review-decision' | 'not-expressible'

const APPROVAL_WIRE_VOCABULARY: Record<string, ApprovalWireVocabulary> = {
  'item/commandExecution/requestApproval': 'modern-decision',
  'item/fileChange/requestApproval': 'modern-decision',
  execCommandApproval: 'legacy-review-decision',
  applyPatchApproval: 'legacy-review-decision',
  // Answering these at all means granting something, so a decision cannot be rendered into them.
  'item/permissions/requestApproval': 'not-expressible',
  'item/tool/requestUserInput': 'not-expressible'
}

/**
 * @param approved the authority's verdict, already made. This function never decides anything; it
 *   only says how — or whether — that verdict can be spoken on this method's wire.
 */
export function renderCodexApprovalOutcome(
  method: string,
  approved: boolean,
  reason: string
): CodexServerRequestOutcome {
  switch (APPROVAL_WIRE_VOCABULARY[method]) {
    case 'modern-decision':
      return { outcome: 'result', result: { decision: approved ? 'accept' : 'decline' } }
    case 'legacy-review-decision':
      return { outcome: 'result', result: { decision: approved ? 'approved' : 'denied' } }
    case 'not-expressible':
      return {
        outcome: 'error',
        code: JSON_RPC_INTERNAL_ERROR,
        message: approved
          ? `orca cannot answer ${method}: granting it would require inventing a grant nobody chose`
          : `orca declined ${method}: ${reason}`
      }
    default:
      // An approval method with no rendering rule is a gap in this table, not permission.
      return {
        outcome: 'error',
        code: JSON_RPC_INTERNAL_ERROR,
        message: `orca has no response shape for ${method}`
      }
  }
}
