// Runs one conversation turn: admission, durable user message, provider turn, durable result.
//
// The provider sits behind `ConversationTurnDriver` so this file holds no Codex vocabulary. That is
// not decoration: the failure ORDER below is the product contract, and it has to be provable
// without spending a real account's tokens on each of the six ways a turn can end.

import type { AgentTurnEvent } from '../../shared/agent-turn-event'
import type { ConversationId, ConversationRecord } from '../../shared/conversation-types'
import type { ConversationTurnOutcome } from '../../shared/conversation-turn'

import type { ConversationService } from './conversation-service'
import { applyAgentTurnEvent, interruptUnsettledTurns } from './conversation-turn-fold'

export type ConversationTurnRequest = {
  conversationId: ConversationId
  text: string
  /** Where the provider should run. A conversation is not a workspace; the caller says. */
  cwd: string
}

export type ProviderTurnRequest = {
  /** The provider thread to continue, or null to begin one. Continuation material, never identity. */
  resumeSessionId: string | null
  cwd: string
  text: string
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

export type { ConversationTurnOutcome }

export type ConversationTurnDeps = {
  service: ConversationService
  driver: ConversationTurnDriver
  /** Answers whether the provider can authenticate AT ALL. Separate from the turn, because an
   *  unauthenticated provider is a product state and not a turn that failed. */
  checkAuth: () => Promise<{ ready: true } | { ready: false; detail: string }>
  mintTurnId: () => string
  mintItemId: () => string
  /** Live-only sink: deltas and status reach the surface here and never reach disk. */
  emit: (conversationId: ConversationId, event: AgentTurnEvent) => void
  now?: () => number
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
    const auth = await deps.checkAuth()
    if (!auth.ready) {
      return { outcome: 'auth-required', detail: auth.detail }
    }

    const resumeSessionId = latestSessionId(existing.record)
    let sawTerminal = false
    // Durable writes are CHAINED and awaited before this function reports success. A turn that
    // returned `completed` while its writes were still in flight would be telling the user their
    // history is saved at the one moment it provably is not.
    let durableChain: Promise<void> = Promise.resolve()
    let durableFailure: string | null = null

    const result = await deps.driver.runTurn({
      resumeSessionId,
      cwd: request.cwd,
      text: request.text,
      turnId,
      onEvent: (event) => {
        deps.emit(conversationId, event)
        if (event.kind === 'turn-completed' || event.kind === 'turn-ended') {
          sawTerminal = true
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
        appendProvenanceOnce(current, result.providerSessionId as string, now())
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

    return { outcome: 'completed', turnId, providerSessionId: result.providerSessionId }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    // A crashed provider must not leave a turn that reads as finished.
    await service.applyEvent(conversationId, (current) =>
      interruptUnsettledTurns(current, now(), 'failed')
    )
    return { outcome: 'failed', turnId, reason }
  } finally {
    admission.release()
  }
}

/** Deltas are transport. Persisting each one would rewrite the same sentence a hundred times and
 *  make an interrupted turn indistinguishable from a finished one. */
function isDurableEvent(event: AgentTurnEvent): boolean {
  return (
    event.kind === 'turn-started' ||
    event.kind === 'message-completed' ||
    event.kind === 'turn-completed' ||
    event.kind === 'turn-ended'
  )
}

function latestSessionId(record: ConversationRecord): string | null {
  for (let index = record.provenance.length - 1; index >= 0; index -= 1) {
    const entry = record.provenance[index]
    if (entry.providerSessionId !== null) {
      return entry.providerSessionId
    }
  }
  return null
}

/** Appends the binding only when it is new, so re-running turns on one thread does not grow the
 *  record with identical lineage entries. */
function appendProvenanceOnce(
  record: ConversationRecord,
  providerSessionId: string,
  at: number
): ConversationRecord {
  const head = record.provenance.at(-1)
  if (head && head.agent === 'codex' && head.providerSessionId === providerSessionId) {
    return record
  }
  return {
    ...record,
    provenance: [
      ...record.provenance,
      { agent: 'codex', providerSessionId, transcriptPath: null, observedAt: at }
    ],
    updatedAt: at
  }
}
