import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { mintConversationId } from '../../shared/conversation-identity'
import {
  CONVERSATION_RECORD_SCHEMA_VERSION,
  type ConversationRecord
} from '../../shared/conversation-types'

import { ConversationStore } from './conversation-store'
import { NonDurableConversationStateError } from './conversation-record-validation'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-conversations-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function record(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  const id = overrides.id ?? mintConversationId()
  return {
    schemaVersion: CONVERSATION_RECORD_SCHEMA_VERSION,
    id,
    title: 'W1',
    createdAt: 100,
    updatedAt: 200,
    status: 'active',
    projectId: null,
    provenance: [],
    turns: [],
    messages: [],
    nextSeq: 0,
    ...overrides
  }
}

function userMessage(seq: number, text: string, turnId: string | null = null) {
  return {
    id: `m-${seq}`,
    seq,
    role: 'user' as const,
    blocks: [{ type: 'text' as const, text }],
    timestamp: 150,
    turnId
  }
}

describe('a conversation survives the process that wrote it', () => {
  it('reloads through a fresh store instance', async () => {
    const written = record({
      messages: [userMessage(0, 'ORCA_W1_DURABLE')],
      nextSeq: 1
    })
    await new ConversationStore(directory).save(written)

    // A different instance, as a relaunch would build. Nothing is carried in memory.
    const reloaded = await new ConversationStore(directory).load(written.id)

    expect(reloaded.outcome).toBe('loaded')
    expect(reloaded.outcome === 'loaded' && reloaded.record).toEqual(written)
  })

  it('keeps an interrupted turn distinguishable from a completed one', async () => {
    // The crash shape: the user message committed, the turn started, no completion ever arrived.
    const written = record({
      messages: [userMessage(0, 'ask', 'turn-1')],
      turns: [{ turnId: 'turn-1', seq: 0, state: 'working', startedAt: 150, endedAt: null }],
      nextSeq: 1
    })
    await new ConversationStore(directory).save(written)

    const reloaded = await new ConversationStore(directory).load(written.id)

    expect(reloaded.outcome).toBe('loaded')
    // Reading back as 'working' with no end time is the honest answer. It must not have been
    // rounded up to 'completed', nor silently dropped for being unfinished.
    expect(reloaded.outcome === 'loaded' && reloaded.record.turns[0]).toEqual({
      turnId: 'turn-1',
      seq: 0,
      state: 'working',
      startedAt: 150,
      endedAt: null
    })
    expect(reloaded.outcome === 'loaded' && reloaded.record.messages).toHaveLength(1)
  })

  it('lists and deletes only the Orca record', async () => {
    const store = new ConversationStore(directory)
    const first = record()
    const second = record()
    await store.save(first)
    await store.save(second)
    // A provider transcript living beside the records must be invisible to this store.
    writeFileSync(join(directory, 'provider-transcript.jsonl'), '{"role":"user"}\n')

    expect((await store.list()).sort()).toEqual([first.id, second.id].sort())

    await store.deleteRecord(first.id)

    expect(await store.list()).toEqual([second.id])
    expect((await readdir(directory)).includes('provider-transcript.jsonl')).toBe(true)
  })
})

describe('an unreadable record is never an empty conversation', () => {
  it('reports a truncated record as unreadable, not absent and not empty', async () => {
    const store = new ConversationStore(directory)
    const written = record({ messages: [userMessage(0, 'keep me')], nextSeq: 1 })
    await store.save(written)

    // Truncate the tail, exactly as a power loss mid-write would leave a non-durable writer.
    const path = join(directory, `${written.id}.json`)
    const whole = readFileSync(path, 'utf-8')
    writeFileSync(path, whole.slice(0, Math.floor(whole.length / 2)))

    const result = await store.load(written.id)

    expect(result.outcome).toBe('unreadable')
    // The critical negative: a caller must not be able to read this as a conversation with no
    // messages, because its next act is a read-modify-write that would publish that emptiness.
    expect(result.outcome === 'unreadable' && result.reason).toContain('not valid JSON')
    expect(readFileSync(path, 'utf-8').length).toBeGreaterThan(0)
  })

  it('separates a missing record from a broken one', async () => {
    const store = new ConversationStore(directory)
    const missing = await store.load(mintConversationId())
    expect(missing.outcome).toBe('absent')

    const brokenId = mintConversationId()
    writeFileSync(join(directory, `${brokenId}.json`), '{"schemaVersion":1,"id":')
    expect((await store.load(brokenId)).outcome).toBe('unreadable')
  })

  it('refuses a record written by a newer build instead of reading it with old assumptions', async () => {
    const store = new ConversationStore(directory)
    const id = mintConversationId()
    writeFileSync(
      join(directory, `${id}.json`),
      JSON.stringify({ ...record({ id }), schemaVersion: CONVERSATION_RECORD_SCHEMA_VERSION + 5 })
    )

    const result = await store.load(id)

    expect(result.outcome).toBe('schema-too-new')
    expect(result.outcome === 'schema-too-new' && result.storedVersion).toBe(
      CONVERSATION_RECORD_SCHEMA_VERSION + 5
    )
  })

  it('refuses a record whose id disagrees with the file it was found in', async () => {
    const store = new ConversationStore(directory)
    const askedFor = mintConversationId()
    writeFileSync(join(directory, `${askedFor}.json`), JSON.stringify(record()))

    const result = await store.load(askedFor)

    expect(result.outcome).toBe('unreadable')
    expect(result.outcome === 'unreadable' && result.reason).toContain('does not match')
  })

  it('refuses to resolve a path for an id that is not an Orca conversation id', async () => {
    const store = new ConversationStore(directory)
    await expect(store.load('../escape')).rejects.toThrow(/non-conversation id/)
  })
})

describe('state that must not become durable never reaches the disk', () => {
  it('refuses hidden reasoning and writes nothing', async () => {
    const store = new ConversationStore(directory)
    const withReasoning = record({
      messages: [
        {
          id: 'm-0',
          seq: 0,
          role: 'reasoning',
          blocks: [{ type: 'text', text: 'private chain of thought' }],
          timestamp: 150,
          turnId: null
        }
      ],
      nextSeq: 1
    })

    await expect(store.save(withReasoning)).rejects.toBeInstanceOf(NonDurableConversationStateError)

    // A refusal and a save that never happened leave the same directory, so the control below is
    // what makes this assertion mean anything.
    expect(await readdir(directory)).toEqual([])
  })

  it('CONTROL: the same record without reasoning does write', async () => {
    const store = new ConversationStore(directory)
    const clean = record({ messages: [userMessage(0, 'visible')], nextSeq: 1 })

    await store.save(clean)

    expect(await readdir(directory)).toEqual([`${clean.id}.json`])
  })

  it('refuses a seq at or beyond the ordering watermark', async () => {
    const store = new ConversationStore(directory)
    const reusedSeq = record({ messages: [userMessage(3, 'x')], nextSeq: 3 })

    await expect(store.save(reusedSeq)).rejects.toThrow(/ordering watermark/)
    expect(await readdir(directory)).toEqual([])
  })

  it('refuses a settled turn that carries no end time', async () => {
    const store = new ConversationStore(directory)
    const settledWithoutEnd = record({
      turns: [{ turnId: 'turn-1', seq: 0, state: 'completed', startedAt: 150, endedAt: null }]
    })

    await expect(store.save(settledWithoutEnd)).rejects.toThrow(/settled but carries no end time/)
    expect(await readdir(directory)).toEqual([])
  })

  it('leaves no temp file behind after a successful publish', async () => {
    const store = new ConversationStore(directory)
    const written = record({ messages: [userMessage(0, 'x')], nextSeq: 1 })

    await store.save(written)

    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})
