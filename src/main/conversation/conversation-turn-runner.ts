// Runs one conversation turn: admission, durable user message, provider turn, durable result.
//
// The provider sits behind `ConversationTurnDriver` so this file holds no Codex vocabulary. That is
// not decoration: the failure ORDER below is the product contract, and it has to be provable
// without spending a real account's tokens on each of the six ways a turn can end.

import type { Agent } from '../../shared/agent-types'
import type { AgentTurnEvent } from '../../shared/agent-turn-event'
import type { ConversationId } from '../../shared/conversation-types'
import type { ConversationTurnOutcome } from '../../shared/conversation-turn'
import {
  appendProviderProvenance,
  latestProviderProvenance
} from '../../shared/conversation-identity'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'

import type { AgentProjectLocation } from './agent-project-location'
import { compileAgentTurnInstructions } from './agent-turn-instructions'
import type { ConversationService } from './conversation-service'
import { applyAgentTurnEvent, interruptUnsettledTurns } from './conversation-turn-fold'
import { ProviderUnavailableError } from './provider-unavailable'

export type ConversationTurnRequest = {
  conversationId: ConversationId
  text: string
  /**
   * Where the provider should run WHEN NOTHING ELSE OWNS THAT ANSWER — a Brainstorming chat, or an
   * agent that owns no project. `null` means the caller has no opinion, and it stays null: a
   * directory nobody chose is not a smaller mistake than no directory.
   *
   * An agent that owns a project overrides this outright. The agent's project is the authority, so
   * a window focused on another project cannot retarget the turn by supplying a cwd.
   */
  cwd: string | null
}

export type ProviderTurnRequest = {
  /** The provider thread to continue, or null to begin one. Continuation material, never identity. */
  resumeSessionId: string | null
  /** The directory that thread was recorded in. Null or absent is UNKNOWN: the driver must then
   *  have the provider confirm the thread is in `cwd` before running the turn in it. */
  resumeCwd?: string | null
  cwd: string
  text: string
  /** What the conversation's agent contributes (agent-turn-instructions.ts), or null for
   *  Brainstorming. Sent on resume too, so the role applies to every turn, not only the first. */
  developerInstructions: string | null
  turnId: string
  onEvent: (event: AgentTurnEvent) => void
}

export type ProviderTurnResult = {
  /** The provider's own thread id, recorded as provenance. Null when it reported none. */
  providerSessionId: string | null
}

export type ConversationTurnDriver = {
  runTurn: (request: ProviderTurnRequest) => Promise<ProviderTurnResult>
}

/** Where a remote project's turn must run: a host, the setup on it, and a path that exists ONLY
 *  there. Carried apart from `cwd` so a remote path has no route to a local child process. */
export type RemoteExecutionTarget = {
  projectId: string
  hostId: `ssh:${string}`
  setupId: string
  path: string
}

export type AuthCheck = () => Promise<{ ready: true } | { ready: false; detail: string }>

/** A remote host either offers a driver and its own auth check, or says why it cannot. Each
 *  refusal has its own fix: reconnect the host, update Orca on it, or set the project up again. */
export type RemoteDriverRefusal =
  | 'remote-host-unreachable'
  | 'remote-relay-unsupported'
  | 'remote-project-missing'
export type RemoteDriverResolution =
  | { driver: ConversationTurnDriver; checkAuth: AuthCheck }
  | { refusal: RemoteDriverRefusal }

/** Keyed by every refusal, so a new one cannot fall into another's sentence. */
const REMOTE_REFUSAL_DETAIL: Record<RemoteDriverRefusal, string> = {
  'remote-host-unreachable': 'This agent’s remote host is not connected.',
  'remote-relay-unsupported': 'Orca on this agent’s remote host is too old to run a chat there.',
  'remote-project-missing': 'This agent’s project directory is not on its remote host.'
}

export type { ConversationTurnOutcome }

export type ConversationTurnDeps = {
  service: ConversationService
  driver: ConversationTurnDriver
  /** Answers whether the provider can authenticate AT ALL. Separate from the turn, because an
   *  unauthenticated provider is a product state and not a turn that failed. */
  checkAuth: () => Promise<{ ready: true } | { ready: false; detail: string }>
  /** Turns the agent's declared project into the directory its turn runs in. Injected rather than
   *  imported so this file keeps holding no PersistedState, and read per call so a setup that
   *  became ready is visible without a restart. */
  resolveProjectLocation: (agent: Agent) => AgentProjectLocation
  /** Where a turn runs when no project owns the answer. Never `process.cwd()`: on a packaged build
   *  that is Orca's own install directory, and an agent rooted there answers about Orca. */
  fallbackCwd: () => string
  /** The provider driver that runs ON a remote project's host, with that host's own auth check —
   *  or a named refusal. Absent means no remote execution exists at all: a refusal, never a local
   *  run. Asked BEFORE admission, so a refusal commits nothing. */
  remoteDriverFor?: (target: RemoteExecutionTarget) => Promise<RemoteDriverResolution>
  mintTurnId: () => string
  mintItemId: () => string
  /** Live-only sink: deltas and status reach the surface here and never reach disk. */
  emit: (conversationId: ConversationId, event: AgentTurnEvent) => void
  now?: () => number
}

type RefusingLocation = Extract<
  AgentProjectLocation,
  { outcome: 'unresolved' | 'not-ready' | 'remote-host' | 'ambiguous-host' }
>
type ProjectUnavailable = Extract<ConversationTurnOutcome, { outcome: 'project-unavailable' }>

/** One refusal per fix. A caller that only had "project unavailable" would send someone to look at
 *  the wrong thing in most cases. */
function describeUnavailableProject(location: RefusingLocation): ProjectUnavailable {
  const refuse = (reason: ProjectUnavailable['reason'], detail: string): ProjectUnavailable => ({
    outcome: 'project-unavailable',
    projectId: location.projectId,
    reason,
    detail
  })
  switch (location.outcome) {
    case 'unresolved':
      return refuse('unresolved', 'This agent’s project is not set up on this computer.')
    case 'not-ready':
      return refuse(
        'not-ready',
        location.hostId === LOCAL_EXECUTION_HOST_ID
          ? `This agent’s project is ${location.setupState} on this computer.`
          : `This agent’s project is ${location.setupState} on a remote host.`
      )
    case 'ambiguous-host':
      return refuse(
        'ambiguous-host',
        `This agent’s project is set up on ${location.hostIds.length} remote hosts, and Orca will not pick one for it.`
      )
    case 'remote-host':
      return refuse(
        'remote-host',
        'This agent’s project lives on a kind of host a chat cannot run on yet.'
      )
  }
}

export async function runConversationTurn(
  deps: ConversationTurnDeps,
  request: ConversationTurnRequest
): Promise<ConversationTurnOutcome> {
  const now = deps.now ?? (() => Date.now())
  const { service } = deps
  const { conversationId } = request

  const existing = await service.read(conversationId)
  if (existing.outcome !== 'loaded') {
    // Includes `unreadable` and `schema-too-new`: none of them is a conversation we may append to,
    // and starting a provider turn for one would spend tokens producing an answer with nowhere to go.
    return { outcome: 'conversation-absent' }
  }

  // Resolved BEFORE admission and the durable write: an agent chat whose agent cannot be found must
  // not run as Brainstorming, and a refused send must not leave the user's message committed.
  const binding = service.agentFor(existing.record)
  if (binding.kind === 'agent-missing' || binding.kind === 'agent-unverifiable') {
    return {
      outcome: 'agent-unavailable',
      agentId: binding.agentId,
      reason: binding.kind === 'agent-missing' ? 'missing' : 'unverifiable'
    }
  }
  // Resolved HERE, beside the agent and before admission, for the same reason the binding is: a
  // turn that cannot be put in its agent's project must not commit the user's message, and must
  // never quietly run somewhere else. This is also the only place the answer is decided, so the
  // window's current focus has no way to reach it.
  const location =
    binding.kind === 'agent'
      ? deps.resolveProjectLocation(binding.agent)
      : { outcome: 'none' as const }
  if (
    location.outcome === 'unresolved' ||
    location.outcome === 'not-ready' ||
    location.outcome === 'remote-host' ||
    location.outcome === 'ambiguous-host'
  ) {
    return describeUnavailableProject(location)
  }

  // A remote project's turn runs ON its host or not at all. With no driver for that host this is a
  // refusal before admission — never the local driver, and never a local directory of any name.
  let driver = deps.driver
  let checkAuth = deps.checkAuth
  if (location.outcome === 'resolved-remote') {
    const target = {
      projectId: location.projectId,
      hostId: location.hostId,
      setupId: location.setupId,
      path: location.path
    }
    const refuse = (
      reason: 'remote-execution-unavailable' | RemoteDriverRefusal,
      detail: string
    ): ConversationTurnOutcome => ({
      outcome: 'project-unavailable',
      projectId: location.projectId,
      reason,
      detail
    })
    if (!deps.remoteDriverFor) {
      return refuse(
        'remote-execution-unavailable',
        'This agent’s project lives on a remote host, and Orca cannot run its chat there.'
      )
    }
    let resolution: RemoteDriverResolution
    try {
      resolution = await deps.remoteDriverFor(target)
    } catch {
      // Nothing escapes before admission: a probe that threw is a host we could not reach.
      resolution = { refusal: 'remote-host-unreachable' }
    }
    if ('refusal' in resolution) {
      return refuse(resolution.refusal, REMOTE_REFUSAL_DETAIL[resolution.refusal])
    }
    // The probe awaited; a project that moved meanwhile must not run at the location read before.
    const again = binding.kind === 'agent' ? deps.resolveProjectLocation(binding.agent) : null
    if (
      again?.outcome !== 'resolved-remote' ||
      again.hostId !== target.hostId ||
      again.setupId !== target.setupId ||
      again.path !== target.path
    ) {
      return {
        outcome: 'project-unavailable',
        projectId: location.projectId,
        reason: 'location-changed',
        detail: 'This agent’s project moved while the message was being sent.'
      }
    }
    driver = resolution.driver
    checkAuth = resolution.checkAuth
  }

  const developerInstructions =
    binding.kind === 'agent' && location.outcome !== 'none'
      ? compileAgentTurnInstructions(binding.agent, location)
      : null

  // An agent's project is the authority and overrides the caller outright; a remote path goes only
  // to the remote driver chosen above. Everything else falls back to a DECLARED location rather
  // than to whatever directory this process happens to be in.
  const cwd =
    location.outcome === 'resolved' || location.outcome === 'resolved-remote'
      ? location.path
      : (request.cwd ?? deps.fallbackCwd())

  const executionHostId: string =
    location.outcome === 'resolved-remote' ? location.hostId : LOCAL_EXECUTION_HOST_ID

  const turnId = deps.mintTurnId()

  // Admission BEFORE the durable write: a refused send must not leave the user's message committed
  // to a conversation that never answers it.
  const admission = service.beginTurn(conversationId, turnId)
  if (admission.outcome === 'busy') {
    return { outcome: 'busy', activeTurnId: admission.activeTurnId }
  }

  try {
    // The user's words are made durable BEFORE the provider is asked anything. A turn that starts
    // first can die between the request and the first durable write, and the sentence the user
    // typed is then the only thing with no record of having existed.
    const committed = await service.commitUserMessage(
      conversationId,
      request.text,
      deps.mintItemId(),
      now()
    )
    if (committed.outcome !== 'published') {
      return { outcome: 'not-durable', reason: committed.outcome }
    }

    // Auth is checked AFTER the message is safe and BEFORE any token is spent. The message stays in
    // the conversation and the surface says the provider needs signing in — which is the truth, and
    // is not an empty assistant reply.
    // The auth check of the host the turn runs on. A remote check that could not ask THROWS, and
    // lands below as `failed` — never as "sign in", which would send someone to fix the wrong thing.
    const auth = await checkAuth()
    if (!auth.ready) {
      return { outcome: 'auth-required', detail: auth.detail }
    }

    // Only a thread recorded on THIS host can be resumed: its history exists nowhere else.
    const resumeFrom = latestProviderProvenance(existing.record, executionHostId)
    let sawTerminal = false
    let endedWithoutAnswer: string | null = null
    // Durable writes are CHAINED and awaited before this function reports success. A turn that
    // returned `completed` while its writes were still in flight would be telling the user their
    // history is saved at the one moment it provably is not.
    let durableChain: Promise<void> = Promise.resolve()
    let durableFailure: string | null = null

    const result = await driver.runTurn({
      resumeSessionId: resumeFrom?.providerSessionId ?? null,
      resumeCwd: resumeFrom?.cwd ?? null,
      cwd,
      text: request.text,
      developerInstructions,
      turnId,
      onEvent: (event) => {
        deps.emit(conversationId, event)
        if (event.kind === 'turn-completed' || event.kind === 'turn-ended') {
          sawTerminal = true
        }
        if (event.kind === 'turn-ended') {
          endedWithoutAnswer ??= event.reason
        }
        if (isDurableEvent(event)) {
          // Not awaited HERE — blocking the provider's event callback would stall the stream — but
          // appended to a chain this function awaits before it answers.
          durableChain = durableChain.then(async () => {
            const applied = await service.applyEvent(conversationId, (current) =>
              applyAgentTurnEvent(current, event, now())
            )
            if (applied.outcome !== 'published' && applied.outcome !== 'unchanged') {
              durableFailure ??= applied.outcome
            }
          })
        }
      }
    })

    await durableChain
    if (durableFailure !== null) {
      // The provider answered and the answer did not reach disk. Reporting that as an ordinary
      // completion is the exact lie the durable owner exists to prevent.
      return { outcome: 'not-durable', reason: durableFailure }
    }

    if (result.providerSessionId !== null) {
      await service.applyEvent(conversationId, (current) =>
        appendProviderProvenance(current, {
          agent: 'codex',
          providerSessionId: result.providerSessionId as string,
          transcriptPath: null,
          observedAt: now(),
          // Omitted for local, so a local turn writes exactly the record shape it always has.
          ...(executionHostId === LOCAL_EXECUTION_HOST_ID ? {} : { executionHostId }),
          // The driver runs a turn only in a thread confirmed to be in `cwd`, so this is observed.
          cwd
        })
      )
    }

    if (!sawTerminal) {
      // The driver returned without the provider ever settling the turn. Leaving it `working` would
      // make an abandoned turn load as one still in progress forever.
      await service.applyEvent(conversationId, (current) =>
        interruptUnsettledTurns(current, now(), 'interrupted')
      )
      return { outcome: 'failed', turnId, reason: 'provider ended without completing the turn' }
    }
    // A turn the provider ended in failure (a usage limit, an error) settled, and did not answer.
    if (endedWithoutAnswer !== null) {
      return { outcome: 'failed', turnId, reason: endedWithoutAnswer }
    }

    return { outcome: 'completed', turnId, providerSessionId: result.providerSessionId }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    // A crashed provider must not leave a turn that reads as finished.
    await service.applyEvent(conversationId, (current) =>
      interruptUnsettledTurns(current, now(), 'failed')
    )
    if (error instanceof ProviderUnavailableError) {
      return { outcome: 'provider-unavailable', reason: error.reason, detail: error.message }
    }
    return { outcome: 'failed', turnId, reason }
  } finally {
    admission.release()
  }
}

/** Deltas are transport. Persisting each one would rewrite the same sentence a hundred times and
 *  make an interrupted turn indistinguishable from a finished one. */
function isDurableEvent(event: AgentTurnEvent): boolean {
  if (event.kind === 'message-completed') {
    // A provider-echoed USER message is dropped, and this was found against the real provider:
    // `codex app-server` reports the prompt back as `item/completed` with `type: 'userMessage'`,
    // under ITS id. Orca already committed those words under its own id, before the provider was
    // asked anything — so the echo carries nothing new, and because the two ids differ the fold's
    // id-keyed replace cannot collapse them. Every user message was being stored twice.
    //
    // Orca is the author of what the user typed. A provider repeating it back has no authority
    // over it. No fixture caught this, because a fake driver echoes nothing.
    return event.role !== 'user'
  }
  return (
    event.kind === 'turn-started' || event.kind === 'turn-completed' || event.kind === 'turn-ended'
  )
}
