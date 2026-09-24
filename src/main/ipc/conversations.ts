import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { BrowserWindow, ipcMain } from 'electron'

import type { AgentGrounding } from '../../shared/agent-grounding'
import { isAgentId } from '../../shared/agent-identity'
import type { AgentTurnEvent } from '../../shared/agent-turn-event'
import { isConversationId } from '../../shared/conversation-identity'
import type { ConversationSummary } from '../../shared/conversation-summary'
import type {
  ConversationForAgentResult,
  ConversationLoadResult,
  ConversationRecord
} from '../../shared/conversation-types'
import { readStoredCodexCredentialState } from '../codex-accounts/managed-codex-auth-readiness'
import { createCodexConversationDriver } from '../codex/codex-conversation-driver'
import { readAgentGrounding } from '../conversation/agent-grounding'
import {
  resolveAgentProjectLocation,
  type ProjectLocationReader
} from '../conversation/agent-project-location'
import {
  ConversationService,
  type ConversationAgentRoster
} from '../conversation/conversation-service'
import {
  runConversationTurn,
  type ConversationTurnDeps,
  type ConversationTurnOutcome,
  type ConversationTurnRequest
} from '../conversation/conversation-turn-runner'
import type { Agent } from '../../shared/agent-types'
import { runAgentTask } from '../conversation/agent-task-execution'
import type { ConversationProviderEntry } from '../conversation/conversation-provider-routing'
import { ProviderQuotaObservations } from '../conversation/provider-quota-observations'
import { runRoutedConversationTurn } from '../conversation/routed-conversation-turn'
import { checkClaudeAuth } from '../claude/claude-auth-readiness'
import { createClaudeConversationDriver } from '../claude/claude-conversation-driver'
import { registerAgentTaskRunner } from '../runtime/orchestration/agent-task-runner-registry'
import { ensureActiveOrcaProfile } from '../orca-profiles/profile-index-store'
import { getOrcaConversationsDirectory } from '../orca-profiles/profile-storage-paths'

/** What each provider last said about its own quota. Process-wide: every window's turns share it. */
const providerQuota = new ProviderQuotaObservations()

/**
 * Why the renderer gets product operations and not a file API: a conversation is a product entity,
 * and the durability that protects it — the temp path, the fsync-before-rename barrier, the
 * ordering watermark and the compare-and-swap that fences it — is main's to keep. A renderer that
 * could send a `nextSeq` could defeat the check that stops a stale writer overwriting newer
 * messages.
 *
 * The active profile is resolved on every call rather than captured at registration, so switching
 * profile takes effect immediately instead of serving the old profile's conversations until restart.
 */

export const CONVERSATION_TURN_EVENT_CHANNEL = 'conversations:turnEvent'

export type ConversationTurnEventPayload = {
  conversationId: string
  event: AgentTurnEvent
}

export type ConversationIpcHandlers = {
  'conversations:list': () => Promise<ConversationSummary[]>
  'conversations:create': (args: {
    title?: string | null
    projectId?: string | null
  }) => Promise<ConversationRecord>
  'conversations:createForAgent': (args: {
    agentId: string
    title?: string | null
  }) => Promise<ConversationForAgentResult>
  'conversations:read': (args: { id: string }) => Promise<ConversationLoadResult>
  'conversations:agentGrounding': (args: { agentId: string }) => Promise<AgentGrounding>
  'conversations:sendTurn': (args: {
    id: string
    text: string
    /** Optional: an agent that owns a project decides this itself. */
    cwd?: string | null
  }) => Promise<ConversationTurnOutcome>
}

/**
 * A malformed id THROWS rather than returning an outcome, matching ConversationStore: the four load
 * outcomes are statements about the user's data, and a renderer sending a string that is not an
 * Orca id is a bug in the renderer. Folding it into `unreadable` would report our own defect as
 * their conversation being corrupt.
 */
function requireConversationId(value: unknown): string {
  if (!isConversationId(value)) {
    throw new Error(`conversations: refusing a value that is not a conversation id: ${String(value)}`)
  }
  return value
}

function requireAgentId(value: unknown): string {
  if (!isAgentId(value)) {
    throw new Error(`conversations: refusing a value that is not an agent id: ${String(value)}`)
  }
  return value
}

function requireText(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('conversations: a turn needs text')
  }
  return value
}

/**
 * Resolves the home the CHILD will read, not one we would like it to read. The driver applies no
 * CODEX_HOME overlay, so the child inherits this process's environment — checking `~/.codex` while
 * the child reads an inherited CODEX_HOME would report "signed in" about a different account.
 */
export function codexAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json')
}

export async function checkCodexAuth(): Promise<{ ready: true } | { ready: false; detail: string }> {
  const state = readStoredCodexCredentialState(codexAuthPath())
  if (state === 'present') {
    return { ready: true }
  }
  // The state is carried through rather than flattened to "not signed in": `unreadable` is a
  // rotation in flight and worth retrying, `no-credential` is a settled logout, and telling a user
  // to sign in again during a token refresh turns a transient race into a support ticket.
  return { ready: false, detail: `codex credential is ${state}` }
}

export type ConversationIpcDeps = {
  service: ConversationService
  turnDeps: Omit<ConversationTurnDeps, 'service'>
  /** Absent means grounding cannot be answered, which is reported as such — never as "missing". */
  roster?: ConversationAgentRoster
  /** The desktop's routed turn. Absent, `turnDeps.driver` runs every turn (the pre-routing path). */
  runTurn?: (request: ConversationTurnRequest) => Promise<ConversationTurnOutcome>
}

export function createConversationIpcHandlers(deps: ConversationIpcDeps): ConversationIpcHandlers {
  const { service } = deps
  // Every handler is `async` so a rejected input is a REJECTED PROMISE and not a synchronous throw.
  // Electron would paper over the difference — ipcMain.handle catches both — but the type here says
  // `Promise`, and a function that sometimes throws before returning one breaks every caller that
  // reasonably does `.catch()` instead of wrapping in try/catch.
  return {
    'conversations:list': async () => service.list(),
    'conversations:create': async (args) =>
      service.create({
        title: typeof args?.title === 'string' ? args.title : null,
        projectId: typeof args?.projectId === 'string' ? args.projectId : null
      }),
    // A malformed id throws (renderer defect); an unknown agent is an outcome (the user's data).
    'conversations:createForAgent': async (args) =>
      service.createForAgent({
        agentId: requireAgentId(args?.agentId),
        title: typeof args?.title === 'string' ? args.title : null
      }),
    'conversations:read': async (args) => service.read(requireConversationId(args?.id)),
    'conversations:agentGrounding': async (args) => {
      const agentId = requireAgentId(args?.agentId)
      if (!deps.roster) {
        return { outcome: 'roster-unreadable', reason: 'no agent roster is wired' }
      }
      return readAgentGrounding(
        {
          roster: deps.roster,
          resolveProjectLocation: deps.turnDeps.resolveProjectLocation,
          checkAuth: deps.turnDeps.checkAuth
        },
        agentId
      )
    },
    'conversations:sendTurn': async (args) => {
      const request: ConversationTurnRequest = {
        conversationId: requireConversationId(args?.id),
        text: requireText(args?.text),
        // An absent cwd stays ABSENT. It used to become `process.cwd()`, which on a packaged
        // build is Orca's own install directory — so an agent asked about "this repository"
        // answered about Orca's packaged files. The runner decides from the agent's project, and
        // falls back to a declared location when nothing owns the answer.
        cwd: typeof args?.cwd === 'string' && args.cwd ? args.cwd : null
      }
      return deps.runTurn
        ? deps.runTurn(request)
        : runConversationTurn({ ...deps.turnDeps, service }, request)
    }
  }
}

let cachedService: ConversationService | null = null

export function getConversationService(agentRoster: ConversationAgentRoster): ConversationService {
  cachedService ??= new ConversationService(
    () => getOrcaConversationsDirectory(ensureActiveOrcaProfile().profile.id),
    agentRoster
  )
  return cachedService
}

/** Broadcast rather than reply-to-sender: a conversation is not owned by the window that happened
 *  to send the turn, and a second window showing the same conversation must see the same stream. */
function broadcastTurnEvent(conversationId: string, event: AgentTurnEvent): void {
  const payload: ConversationTurnEventPayload = { conversationId, event }
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(CONVERSATION_TURN_EVENT_CHANNEL, payload)
    }
  }
}

/** `agentRoster` reads the same PersistedState roster `agents:list` does, so there is one answer
 *  to "does this agent exist" and it follows Project id promotion. `projects` is read the same way
 *  and for the same reason: a setup that became ready must be visible without a restart. */
export function registerConversationHandlers(
  agentRoster: ConversationAgentRoster,
  projects: ProjectLocationReader
): void {
  const service = getConversationService(agentRoster)
  const codex = createCodexConversationDriver()
  const turnDeps = {
    driver: codex,
    checkAuth: checkCodexAuth,
    resolveProjectLocation: (agent: Agent) => resolveAgentProjectLocation(agent, projects),
    // The user's home, never `process.cwd()`. Both are "not a project"; only one of them is a
    // place the person chose to have, and the other is wherever Orca was launched from.
    fallbackCwd: () => homedir(),
    mintTurnId: () => `turn_${randomUUID()}`,
    mintItemId: () => `usr_${randomUUID()}`,
    emit: broadcastTurnEvent
  }
  // Registry order is the default preference; routing explains every provider it passes over.
  // Codex can serve Orca's tools (dynamic tools, measured); Claude cannot yet (no MCP bridge).
  const providers: ConversationProviderEntry[] = [
    { provider: 'codex', driver: codex, checkAuth: checkCodexAuth, tools: 'supported' },
    {
      provider: 'claude',
      driver: createClaudeConversationDriver({
        observeQuota: (quota) => providerQuota.record('claude', quota, Date.now())
      }),
      checkAuth: () => checkClaudeAuth(),
      tools: 'unsupported'
    }
  ]
  const routedDeps = { ...turnDeps, service, providers, quota: providerQuota }
  const handlers = createConversationIpcHandlers({
    service,
    roster: agentRoster,
    turnDeps,
    runTurn: async (request) => (await runRoutedConversationTurn(routedDeps, request)).turn
  })
  // A delegated task runs through these same deps and the same router, so it cannot find a second
  // location rule, a second auth check or a second driver. It prefers a provider that can serve its
  // delegate tool. Headless serve never reaches this and registers nothing.
  registerAgentTaskRunner((request) =>
    runAgentTask(
      {
        ...turnDeps,
        service,
        readAgents: () => agentRoster.readAgents(),
        runTurn: async (turn) => (await runRoutedConversationTurn(routedDeps, turn, { prefersTools: true })).turn
      },
      request
    )
  )
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (_event, args) =>
      (handler as (input: unknown) => Promise<unknown>)(args)
    )
  }
}
