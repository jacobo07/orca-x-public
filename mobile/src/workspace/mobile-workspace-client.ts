import type { AgentGrounding } from '../../../src/shared/agent-grounding'
import type {
  WorkspaceAgentRow,
  WorkspaceThreadRow
} from '../../../src/shared/cognitive-workspace-projection'
import type { RpcResponse } from '../transport/types'

// Workspace on the phone: the same durable agents, threads and projects the desktop shows, read from
// the host's conversations.* methods. The roster arrives already projected by the host's shared
// projection, so the phone never derives "whose project is this thread" on its own.
//
// Why a local copy of the capability: mobile's protocol-version.ts carries no capability constants
// (see agent-history-capability.ts). Keep in lockstep with src/shared/protocol-version.ts
// CONVERSATIONS_RUNTIME_CAPABILITY.
export const MOBILE_CONVERSATIONS_CAPABILITY = 'conversations.v1'

export type WorkspaceRpcClient = {
  sendRequest: (
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number }
  ) => Promise<RpcResponse>
}

/** A turn resolves when the provider has answered; a long answer must not read as a lost send. */
const TURN_TIMEOUT_MS = 10 * 60_000

export type MobileWorkspaceLoad =
  /** The host cannot serve the Workspace — an older build, or one without the service. */
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; agents: WorkspaceAgentRow[]; threads: WorkspaceThreadRow[] }

/**
 * A host that predates the Workspace answers a mobile device `forbidden` (the scope check runs before
 * dispatch), a desktop-scope pairing gets `method_not_found`, and a host without the service answers
 * `capability_unsupported`. All three mean "this host does not do this" — never "you have no agents".
 */
export function isHostWithoutWorkspace(
  error: { code?: string; message?: string } | undefined
): boolean {
  if (!error) {
    return false
  }
  return (
    error.code === 'forbidden' ||
    error.code === 'method_not_found' ||
    error.code === 'capability_unsupported' ||
    (error.message ?? '').includes('not available to mobile clients')
  )
}

export async function loadMobileWorkspace(
  client: WorkspaceRpcClient
): Promise<MobileWorkspaceLoad> {
  const status = await client.sendRequest('status.get')
  if (!status.ok) {
    return { kind: 'error', message: status.error.message || 'Unable to reach host' }
  }
  const capabilities = (status.result as { capabilities?: unknown }).capabilities
  // Fail closed: no advertised capability is "unsupported", never an attempt that might half-work.
  if (!Array.isArray(capabilities) || !capabilities.includes(MOBILE_CONVERSATIONS_CAPABILITY)) {
    return { kind: 'unsupported' }
  }
  const response = await client.sendRequest('conversations.workspace')
  if (!response.ok) {
    return isHostWithoutWorkspace(response.error)
      ? { kind: 'unsupported' }
      : { kind: 'error', message: response.error.message || 'Unable to load the Workspace' }
  }
  const result = response.result as { agents: WorkspaceAgentRow[]; threads: WorkspaceThreadRow[] }
  return { kind: 'ready', agents: result.agents, threads: result.threads }
}

/** The agent's most recent readable thread, or null when it has none yet (a draft). */
export function latestThreadForAgent(
  threads: readonly WorkspaceThreadRow[],
  agentId: string
): string | null {
  let latest: { id: string; updatedAt: number } | null = null
  for (const thread of threads) {
    if (
      thread.outcome !== 'ok' ||
      thread.agent?.kind !== 'agent' ||
      thread.agent.agentId !== agentId
    ) {
      continue
    }
    if (!latest || thread.updatedAt > latest.updatedAt) {
      latest = { id: thread.id, updatedAt: thread.updatedAt }
    }
  }
  return latest?.id ?? null
}

export type MobileSendResult =
  | { kind: 'sent'; conversationId: string; outcome: string; detail: string | null }
  | { kind: 'not-created'; outcome: string }
  | { kind: 'error'; message: string }

/**
 * The first message makes the thread real (createForAgent), exactly as on the desktop; there is no
 * cwd to send — the agent's project decides where the turn runs.
 */
export async function sendMobileAgentMessage(
  client: WorkspaceRpcClient,
  args: { agentId: string; conversationId: string | null; text: string }
): Promise<MobileSendResult> {
  let conversationId = args.conversationId
  if (conversationId === null) {
    const created = await client.sendRequest('conversations.createForAgent', {
      agentId: args.agentId,
      title: args.text.slice(0, 60)
    })
    if (!created.ok) {
      return { kind: 'error', message: created.error.message || 'Unable to start a thread' }
    }
    const result = created.result as { outcome: string; record?: { id: string } }
    if (result.outcome !== 'created' || !result.record) {
      return { kind: 'not-created', outcome: result.outcome }
    }
    conversationId = result.record.id
  }
  const turn = await client.sendRequest(
    'conversations.sendTurn',
    { id: conversationId, text: args.text },
    { timeoutMs: TURN_TIMEOUT_MS }
  )
  if (!turn.ok) {
    return { kind: 'error', message: turn.error.message || 'Unable to send' }
  }
  const outcome = turn.result as { outcome: string; detail?: string; reason?: string }
  return {
    kind: 'sent',
    conversationId,
    outcome: outcome.outcome,
    detail: outcome.detail ?? outcome.reason ?? null
  }
}

/** Where the agent's next turn runs and whether it can, from the turn runner's own resolver. */
export function describeMobileGrounding(grounding: AgentGrounding): {
  location: string
  credential: string | null
  runnable: boolean
} {
  if (grounding.outcome === 'agent-missing') {
    return { location: 'This agent is no longer in your roster', credential: null, runnable: false }
  }
  if (grounding.outcome === 'roster-unreadable') {
    return {
      location: 'Could not read your agents on this computer',
      credential: null,
      runnable: false
    }
  }
  const credential =
    grounding.provider.credential.state === 'ready'
      ? 'Signed in'
      : 'Sign-in needed on this computer'
  const location = grounding.location
  switch (location.outcome) {
    case 'resolved':
      return { location: `This computer · ${location.displayName}`, credential, runnable: true }
    case 'no-project':
      return { location: 'This computer · no project (home folder)', credential, runnable: true }
    case 'unresolved':
      return {
        location: "The agent's project isn't known on this computer",
        credential,
        runnable: false
      }
    case 'not-ready':
      return {
        location: "The agent's project isn't set up on this computer yet",
        credential,
        runnable: false
      }
    case 'remote-host':
      return { location: 'Runs on another computer', credential, runnable: true }
  }
}

/** Product words for a turn's outcome — never the transport's. */
export function describeMobileTurnOutcome(outcome: string): {
  tone: 'ok' | 'attention'
  text: string
} {
  switch (outcome) {
    case 'completed':
      return { tone: 'ok', text: 'Answered' }
    case 'auth-required':
      return {
        tone: 'attention',
        text: 'Sign in to the provider on this computer to get an answer'
      }
    case 'busy':
      return {
        tone: 'attention',
        text: 'This agent is already answering; try again when it finishes'
      }
    case 'project-unavailable':
      return { tone: 'attention', text: "The agent's project is not set up on this computer" }
    case 'agent-unavailable':
      return { tone: 'attention', text: 'This agent is no longer in your roster' }
    case 'not-durable':
      return { tone: 'attention', text: 'Your message could not be saved; nothing was sent' }
    case 'failed':
      return { tone: 'attention', text: 'The provider did not finish the answer' }
    case 'conversation-absent':
      return { tone: 'attention', text: 'This thread is no longer on this computer' }
    default:
      return { tone: 'attention', text: 'The message was not answered' }
  }
}
