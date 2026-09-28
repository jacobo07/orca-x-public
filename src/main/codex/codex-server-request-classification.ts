// Which of Codex's server→client requests Orca will even consider, and what each one is asking
// for.
//
// The inventory is the one the INSTALLED binary describes, not one from documentation:
//   codex app-server generate-json-schema --experimental --out <dir>
//   -> ServerRequest.json, 11 variants, codex-cli 0.153.4, observed 2026-09-21.
//
// It is frozen here on purpose. A Codex release that adds a twelfth request must fail into
// `unknown` and be refused, rather than reaching a branch that guesses what it wants.

import type { AgentApprovalKind } from '../../shared/agent-approval-authority'

/** What kind of answer a server request needs from us. */
export type CodexServerRequestClass =
  /** A decision about whether something may happen. Routed to the approval authority. */
  | { handling: 'approval'; kind: Exclude<AgentApprovalKind, 'unknown'> }
  /** The server asking Orca to perform work on its behalf. Orca implements none of these, and a
   *  guess would be an effect nobody authorized. */
  | { handling: 'unimplemented-service'; method: string }
  /** Not in the installed schema at all. */
  | { handling: 'unknown'; method: string }

/** The six requests that are asking permission. `item/tool/requestUserInput` is included because
 *  it blocks the turn on a human the same way, even though it collects an answer rather than a
 *  yes/no. */
const APPROVAL_REQUESTS: Record<string, Exclude<AgentApprovalKind, 'unknown'>> = {
  'item/commandExecution/requestApproval': 'command-execution',
  'item/fileChange/requestApproval': 'file-change',
  'item/permissions/requestApproval': 'permissions',
  'item/tool/requestUserInput': 'user-input',
  // The two pre-`turn/start` spellings the schema still carries. Same decision, older names.
  execCommandApproval: 'command-execution',
  applyPatchApproval: 'file-change'
}

/** The five that ask Orca to DO something rather than to allow something. `item/tool/call` is the
 *  sharpest: it asks the client to execute a tool, so answering it with a result is an execution,
 *  not an opinion. */
const UNIMPLEMENTED_SERVICE_REQUESTS = new Set([
  'item/tool/call',
  'mcpServer/elicitation/request',
  'account/chatgptAuthTokens/refresh',
  'attestation/generate',
  'currentTime/read'
])

/** Every server request the installed schema declares. Exported so a drift check can compare it
 *  against a freshly generated schema instead of trusting this comment. */
export const CODEX_SCHEMA_SERVER_REQUESTS: readonly string[] = [
  ...Object.keys(APPROVAL_REQUESTS),
  ...UNIMPLEMENTED_SERVICE_REQUESTS
]

export function classifyCodexServerRequest(method: string): CodexServerRequestClass {
  const approvalKind = Object.hasOwn(APPROVAL_REQUESTS, method)
    ? APPROVAL_REQUESTS[method]
    : undefined
  if (approvalKind) {
    return { handling: 'approval', kind: approvalKind }
  }
  if (UNIMPLEMENTED_SERVICE_REQUESTS.has(method)) {
    return { handling: 'unimplemented-service', method }
  }
  return { handling: 'unknown', method }
}
