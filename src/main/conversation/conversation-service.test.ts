import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { mintConversationId } from '../../shared/conversation-identity'
import { CONVERSATION_ID_PREFIX } from '../../shared/conversation-types'

import { ConversationService } from './conversation-service'

let root = ''
let profile = 'alpha'

function service(): ConversationService {
  return new ConversationService(() => join(root, profile, 'conversations'))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-conv-service-'))
  profile = 'alpha'
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('ConversationService — creation and identity', () => {
  it('mints an Orca id and publishes the record durably before returning', async () => {
    const svc = service()
    const created = await svc.create({ title: '  weekend plan  ', projectId: 'proj-1' })

    expect(created.id.startsWith(CONVERSATION_ID_PREFIX)).toBe(true)
    expect(created.title).toBe('weekend plan')
    expect(created.projectId).toBe('proj-1')

    // Read back through a SEPARATE service instance: an in-memory return value would satisfy the
    // assertions above while nothing had reached disk.
    const loaded = await service().read(created.id)
    expect(loaded.outcome).toBe('loaded')
  })

  it('does not fabricate a project binding', async () => {
    const created = await service().create({ title: 'global chat' })
    expect(created.projectId).toBeNull()
  })
})

describe('ConversationService — listing isolates unreadable records', () => {
  it('renders a corrupt record as a row that says so, and keeps the healthy ones', async () => {
    const svc = service()
    const healthy = await svc.create({ title: 'healthy' })

    const corruptId = mintConversationId()
    writeFileSync(join(root, profile, 'conversations', `${corruptId}.json`), '{ truncated', 'utf-8')

    const rows = await svc.list()

    // Positive control: without it, a listing that returned nothing would satisfy every
    // "the corrupt record did not poison the list" assertion below.
    const healthyRow = rows.find((row) => row.id === healthy.id)
    expect(healthyRow?.outcome).toBe('ok')

    const corruptRow = rows.find((row) => row.id === corruptId)
    expect(corruptRow?.outcome).toBe('unreadable')
    expect(rows).toHaveLength(2)
  })

  it('sorts newest activity first and puts unreadable rows last', async () => {
    const svc = service()
    const older = await svc.create({ title: 'older' })
    await svc.commitUserMessage(older.id, 'first', 'item-older')
    const newer = await svc.create({ title: 'newer' })
    await svc.commitUserMessage(newer.id, 'second', 'item-newer')

    const corruptId = mintConversationId()
    writeFileSync(join(root, profile, 'conversations', `${corruptId}.json`), 'not json', 'utf-8')

    const rows = await svc.list()
    expect(rows.at(-1)?.id).toBe(corruptId)
    expect(rows.filter((row) => row.outcome === 'ok')).toHaveLength(2)
  })
})

describe('ConversationService — the user message is durable before anything else', () => {
  it('commits a user message through the fold and survives a fresh reader', async () => {
    const svc = service()
    const created = await svc.create({})

    const result = await svc.commitUserMessage(created.id, 'what should we build?', 'item-1')
    expect(result.outcome).toBe('published')

    const loaded = await service().read(created.id)
    if (loaded.outcome !== 'loaded') {
      throw new Error(`expected loaded, got ${loaded.outcome}`)
    }
    expect(loaded.record.messages).toHaveLength(1)
    expect(loaded.record.messages[0].role).toBe('user')
    expect(loaded.record.messages[0].blocks).toEqual([
      { type: 'text', text: 'what should we build?' }
    ])
  })

  it('is idempotent by item id, so a resend does not double the message', async () => {
    const svc = service()
    const created = await svc.create({})

    await svc.commitUserMessage(created.id, 'hello', 'item-1')
    const second = await svc.commitUserMessage(created.id, 'hello', 'item-1')

    // Idempotency here is about CONTENT, not about suppressing the write: the fold replaces the
    // message in place and returns a fresh record, so the store genuinely republishes. That costs
    // one write per duplicate frame and cannot double a message, which is the property that
    // matters. Asserted exactly rather than loosely, so a fold that started appending instead of
    // replacing would fail here and not only on the length below.
    expect(second.outcome).toBe('published')
    const loaded = await service().read(created.id)
    if (loaded.outcome !== 'loaded') {
      throw new Error(`expected loaded, got ${loaded.outcome}`)
    }
    expect(loaded.record.messages).toHaveLength(1)
  })

  it('refuses to commit into a conversation that does not exist', async () => {
    const result = await service().commitUserMessage(mintConversationId(), 'hi', 'item-1')
    expect(result.outcome).toBe('absent')
  })
})

describe('ConversationService — one active turn per conversation', () => {
  it('refuses a second turn while one is running, and names the one that holds it', async () => {
    const svc = service()
    const created = await svc.create({})

    const first = svc.beginTurn(created.id, 'turn-1')
    expect(first.outcome).toBe('admitted')

    const second = svc.beginTurn(created.id, 'turn-2')
    expect(second).toEqual({ outcome: 'busy', activeTurnId: 'turn-1' })
  })

  it('admits the next turn once the first releases', async () => {
    const svc = service()
    const created = await svc.create({})

    const first = svc.beginTurn(created.id, 'turn-1')
    if (first.outcome !== 'admitted') {
      throw new Error('expected the first turn to be admitted')
    }
    first.release()

    expect(svc.beginTurn(created.id, 'turn-2').outcome).toBe('admitted')
  })

  it('lets different conversations run turns concurrently', async () => {
    const svc = service()
    const a = await svc.create({})
    const b = await svc.create({})

    expect(svc.beginTurn(a.id, 'turn-a').outcome).toBe('admitted')
    expect(svc.beginTurn(b.id, 'turn-b').outcome).toBe('admitted')
  })

  it('will not let a late release open the door for the turn that replaced it', async () => {
    const svc = service()
    const created = await svc.create({})

    const first = svc.beginTurn(created.id, 'turn-1')
    if (first.outcome !== 'admitted') {
      throw new Error('expected the first turn to be admitted')
    }
    first.release()
    svc.beginTurn(created.id, 'turn-2')

    // turn-1 releasing again must not evict turn-2, which is a different turn holding the slot.
    first.release()
    expect(svc.hasActiveTurn(created.id)).toBe(true)
    expect(svc.beginTurn(created.id, 'turn-3')).toEqual({
      outcome: 'busy',
      activeTurnId: 'turn-2'
    })
  })
})

describe('ConversationService — the profile is resolved per call', () => {
  it('stops answering from the old profile once the active profile changes', async () => {
    const svc = service()
    const created = await svc.create({ title: 'alpha only' })
    expect((await svc.list()).map((row) => row.id)).toContain(created.id)

    profile = 'beta'

    // Same service instance, different active profile. A directory captured in the constructor
    // would keep serving alpha's conversations to beta.
    expect(await svc.list()).toEqual([])
    expect((await svc.read(created.id)).outcome).toBe('absent')
  })
})
