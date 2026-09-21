// The product operations a surface asks for, over the durable conversation owner.
//
// The renderer asks for conversations, not for files: nothing here exposes a path, a temp name, the
// ordering watermark or the compare-and-swap. Those are how durability is achieved, not what a
// product means, and a renderer that could send a `nextSeq` could defeat the fence that protects it.
//
// The directory is resolved PER CALL rather than captured once, so switching profile takes effect
// without a restart and a long-lived service cannot keep answering from the profile that was active
// when it was constructed.

import { mintConversationId } from '../../shared/conversation-identity'
import {
  sortConversationSummaries,
  type ConversationSummary
} from '../../shared/conversation-summary'
import {
  CONVERSATION_RECORD_SCHEMA_VERSION,
  type ConversationId,
  type ConversationLoadResult,
  type ConversationRecord
} from '../../shared/conversation-types'
import type { NativeChatBlock } from '../../shared/native-chat-types'

import { ConversationStore, type ConversationAppendResult } from './conversation-store'
import { applyAgentTurnEvent } from './conversation-turn-fold'

export type CreateConversationInput = {
  title?: string | null
  projectId?: string | null
}

/**
 * Admission to run a turn. `busy` is a deliberate product answer, not an error: one conversation
 * runs one turn at a time, so two rapid sends resolve by refusal rather than by whoever's provider
 * event lands first. Two WINDOWS share this process and therefore share this map; two Orca
 * PROCESSES do not, and the store's on-disk fence is what covers them.
 */
export type TurnAdmission =
  | { outcome: 'admitted'; release: () => void }
  | { outcome: 'busy'; activeTurnId: string }

export class ConversationService {
  private readonly activeTurns = new Map<ConversationId, string>()

  constructor(private readonly directoryForActiveProfile: () => string) {}

  /**
   * Cached PER DIRECTORY, and this is load-bearing rather than an optimization.
   *
   * ConversationStore owns the per-conversation append queue that serializes writers. A fresh store
   * per call gives every append its own empty queue, so nothing contends and nothing serializes —
   * concurrent appends then all read the same ordering watermark, the on-disk fence correctly
   * refuses every one after the first, and the losers are reported `superseded` and silently
   * dropped. Measured exactly that way: an assistant message vanished while the user message stayed.
   *
   * Keying on the directory keeps the per-call profile resolution above honest: a different profile
   * is a different directory and therefore a different store, so no queue is shared across profiles.
   */
  private readonly storesByDirectory = new Map<string, ConversationStore>()

  private store(): ConversationStore {
    const directory = this.directoryForActiveProfile()
    const existing = this.storesByDirectory.get(directory)
    if (existing) {
      return existing
    }
    const created = new ConversationStore(directory)
    this.storesByDirectory.set(directory, created)
    return created
  }

  async create(input: CreateConversationInput = {}): Promise<ConversationRecord> {
    const now = Date.now()
    const record: ConversationRecord = {
      schemaVersion: CONVERSATION_RECORD_SCHEMA_VERSION,
      id: mintConversationId(),
      title: input.title?.trim() ? input.title.trim() : null,
      createdAt: now,
      updatedAt: now,
      status: 'active',
      projectId: input.projectId ?? null,
      provenance: [],
      turns: [],
      messages: [],
      nextSeq: 0
    }
    // `save` and not `append`: this establishes the record. Nothing can be racing a conversation
    // whose id was minted a microsecond ago, and append would answer `absent`.
    await this.store().save(record)
    return record
  }

  async read(id: ConversationId): Promise<ConversationLoadResult> {
    return this.store().load(id)
  }

  /**
   * Every record on disk produces exactly one row. A record that cannot be read becomes a row that
   * SAYS so — dropping it would make a conversation the user can see on disk disappear from the
   * product with nothing to ask about, and a later read-modify-write could then publish the
   * emptiness back over it.
   */
  async list(): Promise<ConversationSummary[]> {
    const store = this.store()
    const ids = await store.list()
    const summaries = await Promise.all(ids.map((id) => this.summarize(store, id)))
    return sortConversationSummaries(summaries)
  }

  private async summarize(store: ConversationStore, id: ConversationId): Promise<ConversationSummary> {
    const loaded = await store.load(id)
    switch (loaded.outcome) {
      case 'loaded': {
        const record = loaded.record
        return {
          outcome: 'ok',
          id,
          title: record.title,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          projectId: record.projectId,
          messageCount: record.messages.length,
          lastTurnState: record.turns.at(-1)?.state ?? null
        }
      }
      case 'schema-too-new':
        return { outcome: 'schema-too-new', id, storedVersion: loaded.storedVersion }
      case 'unreadable':
        return { outcome: 'unreadable', id, reason: loaded.reason }
      case 'absent':
        // Listed a moment ago and gone now: another writer deleted it between the readdir and the
        // load. Not a fault, and not something to render as a healthy row.
        return { outcome: 'unreadable', id, reason: 'removed while listing' }
    }
  }

  /**
   * Commits a user message durably. Goes through the SAME fold as every provider event so there is
   * one way a message enters a record, and so the id-keyed replace that makes provider retries
   * idempotent protects a resent user message too.
   *
   * Callers must await this BEFORE starting a turn. A provider turn that begins first can crash
   * between the request and the first durable write, and the message the user typed is then the one
   * thing with no record of ever having existed.
   */
  async commitUserMessage(
    id: ConversationId,
    text: string,
    itemId: string,
    at: number = Date.now()
  ): Promise<ConversationAppendResult> {
    const blocks: NativeChatBlock[] = [{ type: 'text', text }]
    return this.store().append(id, (current) =>
      applyAgentTurnEvent(
        current,
        { kind: 'message-completed', turnId: null, itemId, role: 'user', blocks },
        at
      )
    )
  }

  /** Applies whatever the fold decides for a provider event. The service owns the store; the
   *  gateway owns the wire; neither reaches into the other. */
  async applyEvent(
    id: ConversationId,
    apply: (current: ConversationRecord) => ConversationRecord
  ): Promise<ConversationAppendResult> {
    return this.store().append(id, apply)
  }

  beginTurn(id: ConversationId, turnId: string): TurnAdmission {
    const active = this.activeTurns.get(id)
    if (active !== undefined) {
      return { outcome: 'busy', activeTurnId: active }
    }
    this.activeTurns.set(id, turnId)
    let released = false
    return {
      outcome: 'admitted',
      release: () => {
        // Idempotent, and it refuses to release someone else's turn: a late release from an
        // abandoned turn must not open the door for a second one already admitted after it.
        if (released || this.activeTurns.get(id) !== turnId) {
          return
        }
        released = true
        this.activeTurns.delete(id)
      }
    }
  }

  hasActiveTurn(id: ConversationId): boolean {
    return this.activeTurns.has(id)
  }
}
