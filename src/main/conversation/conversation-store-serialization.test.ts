// A conversation record is republished WHOLE, so an unfenced read-modify-write loses one of two
// concurrent appends. These cases pin the two guarantees that stop it, and they are different
// guarantees: serialization binds writers inside this process, the nextSeq fence binds a writer
// superseded between its read and its publish — including one in another process, which
// serialization cannot see at all. Overlap between different conversations is proven
// deterministically in conversation-append-queue.test.ts rather than by timing anything here.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { mintConversationId } from '../../shared/conversation-identity'
import {
  CONVERSATION_RECORD_SCHEMA_VERSION,
  type ConversationId,
  type ConversationRecord
} from '../../shared/conversation-types'

import { ConversationStore } from './conversation-store'

let directory = ''
let store: ConversationStore
let id: ConversationId

function record(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    schemaVersion: CONVERSATION_RECORD_SCHEMA_VERSION,
    id: overrides.id ?? id,
    title: 'W-B',
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

function userMessage(seq: number, text: string) {
  return {
    id: `m-${seq}`,
    seq,
    role: 'user' as const,
    blocks: [{ type: 'text' as const, text }],
    timestamp: 150,
    turnId: null
  }
}

function withMessage(current: ConversationRecord, text: string): ConversationRecord {
  return {
    ...current,
    messages: [...current.messages, userMessage(current.nextSeq, text)],
    nextSeq: current.nextSeq + 1,
    updatedAt: 300
  }
}

function textsOnDisk(): string[] {
  const parsed = JSON.parse(
    readFileSync(join(directory, `${id}.json`), 'utf-8')
  ) as ConversationRecord
  return parsed.messages.map((message) =>
    message.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')
  )
}

function onDisk(): ConversationRecord {
  return JSON.parse(readFileSync(join(directory, `${id}.json`), 'utf-8')) as ConversationRecord
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'conversation-store-serialization-'))
  store = new ConversationStore(directory)
  id = mintConversationId()
  await store.save(record())
  // The precondition, asserted rather than assumed: if the seed did not land readable, every case
  // below would report 'unreadable' and could be misread as a defect in the fence.
  const seeded = await store.load(id)
  expect(seeded.outcome).toBe('loaded')
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
  directory = ''
})

describe('two concurrent appends to one conversation', () => {
  it('keeps both messages instead of losing the one that read first', async () => {
    const [first, second] = await Promise.all([
      store.append(id, (current) => withMessage(current, 'from writer A')),
      store.append(id, (current) => withMessage(current, 'from writer B'))
    ])

    expect(first.outcome).toBe('published')
    expect(second.outcome).toBe('published')
    expect(textsOnDisk().sort()).toEqual(['from writer A', 'from writer B'])
    // The ordering watermark: two appends must never reuse a sequence number.
    expect(onDisk().messages.map((message) => message.seq)).toEqual([0, 1])
    expect(onDisk().nextSeq).toBe(2)
  })

  it('runs each fold against the result of the one before it, not against a stale read', async () => {
    const seen: number[] = []

    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        store.append(id, (current) => {
          seen.push(current.nextSeq)
          return withMessage(current, `message ${index}`)
        })
      )
    )

    // A lock that only prevented simultaneous WRITES, while letting all five read first, would
    // show 0,0,0,0,0 here and land one message.
    expect(seen).toEqual([0, 1, 2, 3, 4])
    expect(onDisk().messages).toHaveLength(5)
  })
})

describe('the nextSeq fence rejects a publication that was superseded', () => {
  it('refuses when another writer advanced the record between the read and the publish', async () => {
    // Positioned, not hoped for: the competing write happens INSIDE the fold, which is after this
    // append read the record and before it publishes. That is exactly the interval the fence covers,
    // and it stands in for a writer in another process, which serialization cannot see.
    const result = await store.append(id, (current) => {
      const overtaken = withMessage(current, 'written by someone else')
      writeFileSync(join(directory, `${id}.json`), `${JSON.stringify(overtaken, null, 2)}\n`)
      return withMessage(current, 'this one is stale')
    })

    expect(result).toEqual({ outcome: 'superseded', expectedNextSeq: 0, actualNextSeq: 1 })
    // The newer work survived, which is the entire point. Asserting only on the outcome would pass
    // against a refusal that clobbered anyway.
    expect(textsOnDisk()).toEqual(['written by someone else'])
  })

  it('refuses rather than publishing when the record became unreadable mid-append', async () => {
    const result = await store.append(id, (current) => {
      writeFileSync(join(directory, `${id}.json`), '{ not json')
      return withMessage(current, 'should not land')
    })

    // A watermark that cannot be read matches no expectation. Absence of an answer is not evidence
    // that publishing is safe.
    expect(result.outcome).toBe('superseded')
    expect(readFileSync(join(directory, `${id}.json`), 'utf-8')).toBe('{ not json')
  })
})

describe('append answers the states that are not a write', () => {
  it('reports an absent conversation as absent rather than creating one', async () => {
    const missing = mintConversationId()

    const result = await store.append(missing, (current) => withMessage(current, 'x'))

    expect(result).toEqual({ outcome: 'absent' })
  })

  it('reports a fold that changed nothing as unchanged, not as a write', async () => {
    const result = await store.append(id, (current) => current)

    expect(result.outcome).toBe('unchanged')
    expect(onDisk().messages).toHaveLength(0)
  })

  it('refuses to append over a record written by a newer Orca', async () => {
    writeFileSync(
      join(directory, `${id}.json`),
      `${JSON.stringify(
        { ...record(), schemaVersion: CONVERSATION_RECORD_SCHEMA_VERSION + 1 },
        null,
        2
      )}\n`
    )

    const result = await store.append(id, (current) => withMessage(current, 'x'))

    // Distinct from unreadable: the file is fine, this Orca is old. Republishing it in the older
    // shape would silently drop whatever the newer schema carries, so the fix is to update Orca.
    expect(result).toEqual({
      outcome: 'schema-too-new',
      storedVersion: CONVERSATION_RECORD_SCHEMA_VERSION + 1
    })
  })
})
