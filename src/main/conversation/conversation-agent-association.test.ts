import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { mintAgentId } from '../../shared/agent-identity'
import {
  appendProviderProvenance,
  latestProviderProvenance,
  mintConversationId,
  provenanceHostId
} from '../../shared/conversation-identity'
import {
  CONVERSATION_RECORD_SCHEMA_VERSION,
  type ConversationRecord
} from '../../shared/conversation-types'
import { parseConversationRecord } from './conversation-record-parse'
import { ConversationStore } from './conversation-store'

// Binding a conversation to an agent must not cost anyone their history. The schema version does
// NOT move: conversation-record-parse refuses any LOWER version as `unreadable`, so a bump would
// report every conversation written before today as corrupt.

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-agent-conversations-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function record(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  const id = overrides.id ?? mintConversationId()
  return {
    schemaVersion: CONVERSATION_RECORD_SCHEMA_VERSION,
    id,
    title: 'W-C2',
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

describe('a conversation may be with an agent', () => {
  it('keeps the binding across a real write and a cold read', async () => {
    const agentId = mintAgentId()
    const written = record({ agentId })
    const store = new ConversationStore(directory)
    await store.save(written)

    const loaded = await new ConversationStore(directory).load(written.id)
    expect(loaded.outcome).toBe('loaded')
    expect(loaded.outcome === 'loaded' && loaded.record.agentId).toBe(agentId)
  })

  it('still loads a pre-agent conversation, and does not invent a binding', async () => {
    const legacy = record()
    delete (legacy as { agentId?: unknown }).agentId
    const store = new ConversationStore(directory)
    await store.save(legacy)

    const loaded = await store.load(legacy.id)
    expect(loaded.outcome).toBe('loaded')
    expect(loaded.outcome === 'loaded' && loaded.record.agentId).toBeUndefined()
    // Brainstorming stays valid and stays agent-less. Absent is not corrupt and not "agent unknown".
    expect(loaded.outcome === 'loaded' && loaded.record.projectId).toBeNull()
  })

  it('refuses a record whose agent binding cannot be read', () => {
    const malformed = JSON.stringify({ ...record({ id: 'conv_x' }), agentId: 42 })
    const parsed = parseConversationRecord(malformed, 'conv_x')
    expect(parsed.outcome).toBe('unreadable')
  })

  // The forward-compatibility half, and the reason no schema bump is needed: an OLDER build that
  // has never heard of `agentId` must not strip it while appending. It reads the record, spreads
  // it in a fold, and stringifies what it was handed — so an unknown key has to survive that trip.
  // Simulated with a key no build knows, because today's build would preserve `agentId` for the
  // uninteresting reason that it now knows about it.
  it('preserves a field it has never heard of through an append', async () => {
    const base = record()
    const store = new ConversationStore(directory)
    const raw = { ...base, someFutureField: 'ORCA_WC2_SURVIVES' }
    writeFileSync(join(directory, `${base.id}.json`), `${JSON.stringify(raw, null, 2)}\n`, 'utf8')

    const result = await store.append(base.id, (current) => ({
      ...current,
      title: 'appended',
      nextSeq: current.nextSeq + 1
    }))
    expect(result.outcome).toBe('published')

    const loaded = await store.load(base.id)
    expect(loaded.outcome).toBe('loaded')
    expect(
      loaded.outcome === 'loaded' &&
        (loaded.record as unknown as { someFutureField?: string }).someFutureField
    ).toBe('ORCA_WC2_SURVIVES')
  })

  it('does not move the schema version to carry the binding', () => {
    expect(CONVERSATION_RECORD_SCHEMA_VERSION).toBe(1)
  })
})

describe('a provider binding knows which host its thread lives on', () => {
  const entry = (overrides: Record<string, unknown> = {}) => ({
    agent: 'codex',
    providerSessionId: 'thr-1',
    transcriptPath: null,
    observedAt: 1,
    ...overrides
  })

  it('loads a binding written before remote turns existed, and reads it as local', () => {
    const legacy = JSON.stringify(record({ id: 'conv_x', provenance: [entry()] as never }))
    const parsed = parseConversationRecord(legacy, 'conv_x')
    expect(parsed.outcome).toBe('loaded')
    expect(parsed.outcome === 'loaded' && provenanceHostId(parsed.record.provenance[0])).toBe(
      'local'
    )
  })

  it('refuses a host that is present but empty — a stand-in is not a host', () => {
    const malformed = JSON.stringify(
      record({ id: 'conv_x', provenance: [entry({ executionHostId: '' })] as never })
    )
    expect(parseConversationRecord(malformed, 'conv_x').outcome).toBe('unreadable')
  })

  it('resumes only a thread recorded on the host asked about', () => {
    const conversation = record({
      provenance: [
        entry({ providerSessionId: 'local-thread' }),
        entry({ providerSessionId: 'remote-thread', executionHostId: 'ssh:box' })
      ] as never
    })
    expect(latestProviderProvenance(conversation, 'local')?.providerSessionId).toBe('local-thread')
    expect(latestProviderProvenance(conversation, 'ssh:box')?.providerSessionId).toBe(
      'remote-thread'
    )
    expect(latestProviderProvenance(conversation, 'ssh:other')).toBeNull()
  })

  it('records the same thread seen on another host as new lineage, not a duplicate', () => {
    const conversation = record({ provenance: [entry()] as never })
    const appended = appendProviderProvenance(conversation, {
      ...entry(),
      executionHostId: 'ssh:box'
    } as never)
    expect(appended.provenance).toHaveLength(2)
    expect(
      appendProviderProvenance(appended, { ...entry(), executionHostId: 'ssh:box' } as never)
    ).toBe(appended)
  })

  it('refuses a directory that is present but empty, and loads one that is not', () => {
    const withCwd = (cwd: string) =>
      parseConversationRecord(
        JSON.stringify(record({ id: 'conv_x', provenance: [entry({ cwd })] as never })),
        'conv_x'
      ).outcome
    expect(withCwd('')).toBe('unreadable')
    expect(withCwd('/repos/a')).toBe('loaded')
  })

  it('finds a thread by the host address when another device named the host differently', () => {
    const conversation = record({
      provenance: [
        entry({
          providerSessionId: 'remote-thread',
          executionHostId: 'ssh:target-on-a',
          hostAddress: 'dev@gex44:22'
        })
      ] as never
    })
    expect(
      latestProviderProvenance(conversation, 'ssh:target-on-b', 'dev@gex44:22')?.providerSessionId
    ).toBe('remote-thread')
    expect(latestProviderProvenance(conversation, 'ssh:target-on-b', 'dev@other:22')).toBeNull()
    expect(latestProviderProvenance(conversation, 'ssh:target-on-b')).toBeNull()
  })

  it('records the same thread relocated to another directory as new lineage', () => {
    const conversation = record({ provenance: [entry({ cwd: '/repos/a' })] as never })
    const moved = appendProviderProvenance(conversation, { ...entry(), cwd: '/repos/b' } as never)
    expect(moved.provenance).toHaveLength(2)
    expect(appendProviderProvenance(moved, { ...entry(), cwd: '/repos/b' } as never)).toBe(moved)
  })
})
