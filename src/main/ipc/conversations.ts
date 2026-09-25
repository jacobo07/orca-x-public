import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'

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
import type { Project } from '../../shared/project-types'
import { checkCodexAuth } from '../codex/codex-auth-readiness'
import { createCodexConversationDriver } from '../codex/codex-conversation-driver'
import { readAgentGrounding } from '../conversation/agent-grounding'
import {
  resolveAgentProjectLocation,
  type ProjectLocationReader
} from '../conversation/agent-project-location'
import {
  createConversationHost,
  type ConversationHost,
  type ConversationTurnEventListener
} from '../conversation/conversation-host'
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
import { runAgentTask, type AgentTaskExecutionDeps } from '../conversation/agent-task-execution'
import { ProviderQuotaObservations } from '../conversation/provider-quota-observations'
import { composeProviderRouting } from '../conversation/provider-routing-composition'
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
    throw new Error(
      `conversations: refusing a value that is not a conversation id: ${String(value)}`
    )
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

// Moved to an Electron-free module so provider routing can be composed outside this file; it keeps
// the managed credential states (unreadable vs no-credential) the Workspace branch introduced.
export { checkCodexAuth, codexAuthPath } from '../codex/codex-auth-readiness'

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

const turnEventListeners = new Set<ConversationTurnEventListener>()

/** Paired clients (runtime RPC) hear the same turn stream the windows do. */
export function subscribeConversationTurnEvents(
  listener: ConversationTurnEventListener
): () => void {
  turnEventListeners.add(listener)
  return () => {
    turnEventListeners.delete(listener)
  }
}

/** Broadcast rather than reply-to-sender: a conversation is not owned by the window that happened
 *  to send the turn, and a second window showing the same conversation must see the same stream. */
export function broadcastTurnEvent(conversationId: string, event: AgentTurnEvent): void {
  const payload: ConversationTurnEventPayload = { conversationId, event }
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(CONVERSATION_TURN_EVENT_CHANNEL, payload)
    }
  }
  for (const listener of turnEventListeners) {
    try {
      listener(payload)
    } catch (error) {
      // One paired client's failure must not stop the turn or the other listeners.
      console.warn('[conversations] turn event listener failed', error)
    }
  }
}

let cachedHandlers: ConversationIpcHandlers | null = null
let cachedTaskRunnerDeps: AgentTaskExecutionDeps | null = null

/**
 * One handler set per process, shared by the IPC channels and the runtime RPC, so desktop and a
 * paired phone go through the same service and the same turn admission. `agentRoster` reads the
 * same PersistedState roster `agents:list` does; `projects` is read per call so a setup that became
 * ready is visible without a restart.
 */
export function getConversationHandlers(
  agentRoster: ConversationAgentRoster,
  projects: ProjectLocationReader
): ConversationIpcHandlers {
  if (cachedHandlers) {
    return cachedHandlers
  }
  const service = getConversationService(agentRoster)
  const turnDeps = {
    driver: createCodexConversationDriver(),
    checkAuth: checkCodexAuth,
    resolveProjectLocation: (agent: Agent) => resolveAgentProjectLocation(agent, projects),
    // The user's home, never `process.cwd()`. Both are "not a project"; only one of them is a
    // place the person chose to have, and the other is wherever Orca was launched from.
    fallbackCwd: () => homedir(),
    mintTurnId: () => `turn_${randomUUID()}`,
    mintItemId: () => `usr_${randomUUID()}`,
    emit: broadcastTurnEvent
  }
  // Routed here, in the one handler set, so a paired phone's turn picks its provider exactly as a
  // desktop turn does.
  const routing = composeProviderRouting({ base: { ...turnDeps, service }, quota: providerQuota })
  cachedTaskRunnerDeps = {
    ...turnDeps,
    service,
    readAgents: () => agentRoster.readAgents(),
    runRoutedTurn: (turn, requirement) => routing.runTurn(turn, { prefersTools: true, ...requirement })
  }
  cachedHandlers = createConversationIpcHandlers({
    service,
    roster: agentRoster,
    turnDeps,
    runTurn: async (request) => (await routing.runTurn(request)).turn
  })
  return cachedHandlers
}

/** The paired-client face of the same handlers (see conversation-host.ts for what it withholds). */
export function getConversationHost(
  agentRoster: ConversationAgentRoster,
  projects: ProjectLocationReader,
  readProjects: () => readonly Project[]
): ConversationHost {
  const handlers = getConversationHandlers(agentRoster, projects)
  return createConversationHost({
    list: handlers['conversations:list'],
    read: handlers['conversations:read'],
    agentGrounding: handlers['conversations:agentGrounding'],
    createForAgent: handlers['conversations:createForAgent'],
    sendTurn: handlers['conversations:sendTurn'],
    readAgents: () => agentRoster.readAgents(),
    readProjects,
    subscribe: subscribeConversationTurnEvents
  })
}

export function registerConversationHandlers(
  agentRoster: ConversationAgentRoster,
  projects: ProjectLocationReader
): void {
  const handlers = getConversationHandlers(agentRoster, projects)
  // A delegated task runs through these same deps and the same router, so it cannot find a second
  // location rule, a second auth check or a second driver. Only the desktop registers it: headless
  // serve now hosts conversations for paired phones, but its agent tasks still wait (P2b), stated.
  const taskRunnerDeps = cachedTaskRunnerDeps!
  registerAgentTaskRunner((request) => runAgentTask(taskRunnerDeps, request))
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (_event, args) =>
      (handler as (input: unknown) => Promise<unknown>)(args)
    )
  }
}
