import type { AiVaultSession } from '../../../src/shared/ai-vault-types'
import {
  AGENT_SESSION_HOST_AUTHORITY_CAPABILITY,
  type RuntimeEnsureAgentSessionRequest
} from '../../../src/shared/agent-session-host-authority'
import { isAgentSessionLegacyFallbackErrorCode } from '../../../src/shared/agent-session-legacy-fallback'
import { agentSessionResumeNeedsRecordedContext } from '../../../src/shared/agent-session-resume-context'
import { isResumableTuiAgent } from '../../../src/shared/agent-session-resume'
import { parseAgentSessionResumeRefusalErrorCode } from '../../../src/shared/agent-session-resume-refusal'
import { normalizeAiVaultResumeFilePath } from '../../../src/shared/ai-vault-resume-path'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../../src/shared/cross-platform-path'
import type { LiveSessionResumeRefusal } from '../../../src/shared/live-agent-session-presence-types'
import {
  AGENT_SESSION_OMP_RESUME_PATH_RUNTIME_CAPABILITY,
  AGENT_SESSION_RESUME_CONTEXT_RUNTIME_CAPABILITY
} from '../../../src/shared/protocol-version'
import type { RpcClient } from '../transport/rpc-client'
import {
  buildMobileAiVaultResumeLaunch,
  resumeAiVaultSessionInTerminal,
  type MobileAiVaultResumeSettings
} from './ai-vault-resume-launch'
import { RESUME_RPC_TIMEOUT_MS } from './ai-vault-resume-preparation'
import { activateMobileSessionTab } from './mobile-session-tab-activation'

type ResumeClient = Pick<RpcClient, 'sendRequest'>

export type MobileAiVaultResumeRequest = {
  session: AiVaultSession
  worktreeId: string
  workspacePath: string | null
  hostPlatform: NodeJS.Platform
  hostTerminalWindowsShell: string | null
  settings: MobileAiVaultResumeSettings | null
  clientMutationId: string
}

/** Why the resume travelled as typed command text, which no collision guard can see. */
export type MobileAiVaultLegacyResumeReason =
  // The host launch cannot reproduce this session's command (no startup plan, Codex account home,
  // a cwd other than the workspace root): structured ensure would resume somewhere else.
  | 'launch-not-reproducible'
  // Decided before sending: the host does not advertise the structured method, or could not say.
  | 'host-lacks-structured-resume'
  // Decided before sending: the host has the method but not the guarantee this session needs —
  // it would start at the workspace root under its own provider home.
  | 'host-lacks-context-fidelity'
  // The host answered with a reply that proves nothing started.
  | 'host-requires-legacy'

export type MobileAiVaultResumeOutcome =
  | {
      path: 'structured'
      disposition: 'created' | 'adopted'
      worktreeId: string
      tabId: string | null
      terminal: string
    }
  | {
      path: 'legacy'
      legacyReason: MobileAiVaultLegacyResumeReason
      worktreeId: string
      tabId: string
      terminal: string
    }

/** The host's collision guard refused before any runtime started; nothing was created. */
export class MobileAiVaultResumeRefusedError extends Error {
  constructor(readonly reason: LiveSessionResumeRefusal) {
    super(mobileAiVaultResumeRefusalMessage(reason))
    this.name = 'MobileAiVaultResumeRefusedError'
  }
}

export function mobileAiVaultResumeRefusalMessage(reason: LiveSessionResumeRefusal): string {
  switch (reason) {
    case 'live-elsewhere':
    case 'multiple-live-owners':
      return 'This session is open in another pane.'
    case 'materializing':
      return 'This session is already starting in another pane.'
    case 'unknown':
      return "Orca couldn't confirm this session is free."
  }
}

/**
 * The exact structured request for this selection, or null when the host launch would not
 * reproduce the typed command (so the structured path would resume the wrong thing).
 */
export function planMobileAiVaultStructuredResume(
  request: Pick<
    MobileAiVaultResumeRequest,
    'session' | 'worktreeId' | 'workspacePath' | 'hostPlatform'
  >,
  hasStartupPlan: boolean
): Extract<RuntimeEnsureAgentSessionRequest, { kind: 'explicit' }> | null {
  const { session } = request
  if (!hasStartupPlan || !isResumableTuiAgent(session.agent) || !session.sessionId) {
    return null
  }
  // Why: the host re-enters the recorded directory, but only inside the workspace it is
  // resuming into; anything else it refuses, so the typed command still owns that case.
  const startupCwd =
    session.cwd && !isSameWorkspacePath(session.cwd, request.workspacePath)
      ? session.cwd.trim()
      : null
  if (startupCwd && !isInsideWorkspace(startupCwd, request.workspacePath)) {
    return null
  }
  const ompResumeFilePath =
    session.agent === 'omp'
      ? normalizeAiVaultResumeFilePath(session.filePath, request.hostPlatform)
      : null
  return {
    kind: 'explicit',
    worktree: `id:${request.worktreeId}`,
    agent: session.agent,
    providerSession: {
      key: 'session_id',
      id: session.sessionId,
      // Why: the host resolves which provider account home this session belongs to from
      // its transcript. Mobile names the file; it never names the home.
      ...(session.filePath?.trim() ? { transcriptPath: session.filePath.trim() } : {})
    },
    ...(ompResumeFilePath ? { ompResumeFilePath } : {}),
    ...(startupCwd ? { startupCwd } : {}),
    presentation: 'background'
  }
}

function isInsideWorkspace(cwd: string, workspacePath: string | null): boolean {
  return workspacePath !== null && isPathInsideOrEqual(workspacePath, cwd)
}

/** Turns an explicit AI Vault selection into a running session on the host. */
export async function materializeMobileAiVaultResume(
  client: ResumeClient,
  request: MobileAiVaultResumeRequest
): Promise<MobileAiVaultResumeOutcome> {
  const launch = buildMobileAiVaultResumeLaunch({
    session: request.session,
    hostPlatform: request.hostPlatform,
    hostTerminalWindowsShell: request.hostTerminalWindowsShell,
    settings: request.settings
  })
  const legacy = async (
    legacyReason: MobileAiVaultLegacyResumeReason
  ): Promise<MobileAiVaultResumeOutcome> => {
    const tab = await resumeAiVaultSessionInTerminal(client, request.worktreeId, {
      ...launch,
      clientMutationId: request.clientMutationId
    })
    return {
      path: 'legacy',
      legacyReason,
      worktreeId: request.worktreeId,
      tabId: tab.id,
      terminal: tab.terminal
    }
  }

  const structured = planMobileAiVaultStructuredResume(request, launch.launchConfig !== undefined)
  if (!structured) {
    return await legacy('launch-not-reproducible')
  }
  const needsRecordedContext = agentSessionResumeNeedsRecordedContext({
    agent: request.session.agent,
    sessionCwd: request.session.cwd,
    workspacePath: request.workspacePath
  })
  // Why: decided before sending, so an ambiguous structured reply can never turn into a second launch.
  const support = await hostSupportsStructuredResume(client, {
    omp: structured.agent === 'omp',
    needsRecordedContext
  })
  if (support !== 'supported') {
    return await legacy(
      support === 'lacks-context-fidelity'
        ? 'host-lacks-context-fidelity'
        : 'host-lacks-structured-resume'
    )
  }
  const response = await client.sendRequest('terminal.ensureAgentSession', structured, {
    timeoutMs: RESUME_RPC_TIMEOUT_MS
  })
  if (!response.ok) {
    const refusal = parseAgentSessionResumeRefusalErrorCode(response.error.code)
    if (refusal) {
      throw new MobileAiVaultResumeRefusedError(refusal)
    }
    if (isAgentSessionLegacyFallbackErrorCode(response.error.code)) {
      return await legacy('host-requires-legacy')
    }
    throw new Error(response.error.message || 'Failed to resume session.')
  }
  const result = readEnsureResult(response.result)
  if (!result) {
    throw new Error('Resume response was invalid')
  }
  if (result.tabId) {
    // Why: the session is already running; failing to focus its tab is not a failed resume.
    await activateMobileSessionTab(client, {
      worktree: `id:${request.worktreeId}`,
      tabId: result.tabId,
      notifyClients: false,
      navigation: 'caller',
      intent: 'user'
    }).catch(() => undefined)
  }
  return {
    path: 'structured',
    disposition: result.disposition,
    worktreeId: request.worktreeId,
    tabId: result.tabId,
    terminal: result.terminal
  }
}

async function hostSupportsStructuredResume(
  client: ResumeClient,
  required: { omp: boolean; needsRecordedContext: boolean }
): Promise<'supported' | 'unsupported' | 'lacks-context-fidelity'> {
  let capabilities: unknown
  try {
    const status = await client.sendRequest('status.get', undefined, {
      timeoutMs: RESUME_RPC_TIMEOUT_MS
    })
    if (!status.ok) {
      return 'unsupported'
    }
    capabilities = (status.result as { capabilities?: unknown } | null)?.capabilities
  } catch {
    // Why: a failed read-only probe started nothing, so the compatible launch cannot duplicate.
    return 'unsupported'
  }
  if (!Array.isArray(capabilities)) {
    return 'unsupported'
  }
  if (
    !capabilities.includes(AGENT_SESSION_HOST_AUTHORITY_CAPABILITY) ||
    (required.omp && !capabilities.includes(AGENT_SESSION_OMP_RESUME_PATH_RUNTIME_CAPABILITY))
  ) {
    return 'unsupported'
  }
  // Why: kept apart from the method being absent — this host answers, and would resume the
  // right session in the wrong directory or under the wrong account.
  if (
    required.needsRecordedContext &&
    !capabilities.includes(AGENT_SESSION_RESUME_CONTEXT_RUNTIME_CAPABILITY)
  ) {
    return 'lacks-context-fidelity'
  }
  return 'supported'
}

function readEnsureResult(value: unknown): {
  disposition: 'created' | 'adopted'
  worktreeId: string
  tabId: string | null
  terminal: string
} | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const { terminal, disposition } = value as { terminal?: unknown; disposition?: unknown }
  if (!terminal || typeof terminal !== 'object') {
    return null
  }
  const { handle, tabId, worktreeId } = terminal as Record<string, unknown>
  if (
    typeof handle !== 'string' ||
    typeof worktreeId !== 'string' ||
    (disposition !== 'created' && disposition !== 'adopted')
  ) {
    return null
  }
  return {
    disposition,
    worktreeId,
    tabId: typeof tabId === 'string' ? tabId : null,
    terminal: handle
  }
}

function isSameWorkspacePath(cwd: string, workspacePath: string | null): boolean {
  return (
    workspacePath !== null &&
    normalizeRuntimePathForComparison(cwd) === normalizeRuntimePathForComparison(workspacePath)
  )
}
