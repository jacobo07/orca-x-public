import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ConversationLoadResult, ConversationRecord } from '../../../shared/conversation-types'
import { ConversationStore } from '../../conversation/conversation-store'
import type { BacklogIngestEntryResult } from '../backlog-candidate-operations'
import type * as RecordFile from '../backlog-record-file'
import { BacklogService } from '../backlog-service'
import { createBacklogHarvestRunner } from './backlog-harvest-runner'
import type { HarvestIngestPort } from './harvest-ingest-pipeline'
import { conversationSourceFromStore, type BacklogConversationSource } from './orca-conversation-harvest'

// Boundary fault: every new-record publish from call number `failFrom` on reports storage-failed.
const fault = vi.hoisted(() => ({ failFrom: null as number | null, calls: 0 }))

vi.mock('../backlog-record-file', async (importOriginal) => {
  const actual = await importOriginal<typeof RecordFile>()
  return {
    ...actual,
    publishNewBacklogRecord: (async (finalPath, payload) => {
      fault.calls += 1
      return fault.failFrom !== null && fault.calls >= fault.failFrom
        ? { outcome: 'storage-failed', stage: 'publish', code: 'EIO' }
        : actual.publishNewBacklogRecord(finalPath, payload)
    }) as typeof actual.publishNewBacklogRecord
  }
})

function recordOf(
  id: string,
  userTexts: string[],
  options: { turnState?: string; answered?: boolean; schemaVersion?: number } = {}
): ConversationRecord {
  const messages = userTexts.map((text, index) => ({
    id: `m${index}`,
    seq: index + 1,
    role: 'user',
    blocks: [{ type: 'text', text }],
    timestamp: 1_000 + index,
    turnId: 't1'
  }))
  if (options.answered ?? true) {
    messages.push({
      id: 'answer',
      seq: userTexts.length + 1,
      role: 'assistant',
      blocks: [{ type: 'text', text: 'ok' }],
      timestamp: 5_000,
      turnId: 't1'
    })
  }
  return {
    schemaVersion: options.schemaVersion ?? 1,
    id,
    title: 'a title',
    createdAt: 1,
    updatedAt: 9_000,
    status: 'active',
    projectId: null,
    provenance: [],
    turns: [
      {
        turnId: 't1',
        seq: 0,
        state: options.turnState ?? 'completed',
        startedAt: 1,
        endedAt: options.turnState === 'working' ? null : 2
      }
    ],
    messages,
    nextSeq: userTexts.length + 2
  } as ConversationRecord
}

function markers(count: number, prefix: string): string {
  return Array.from({ length: count }, (_, index) => `- [ ] ${prefix} item ${index}`).join('\n')
}

// In-memory source: ids as given, records built on demand, every read logged.
function memorySource(records: Map<string, ConversationRecord>, order?: string[]) {
  const reads: string[] = []
  let inFlight = 0
  let maxInFlight = 0
  const source: BacklogConversationSource = {
    listIds: async () => order ?? [...records.keys()],
    read: async (id): Promise<ConversationLoadResult> => {
      reads.push(id)
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setImmediate(resolve))
      inFlight -= 1
      const record = records.get(id)
      return record ? { outcome: 'loaded', record } : { outcome: 'absent' }
    }
  }
  return { source, reads, maxInFlight: () => maxInFlight }
}

function publishingPort() {
  const chunks: number[] = []
  const port: HarvestIngestPort = {
    ingestCandidates: async (entries) => {
      chunks.push(entries.length)
      return entries.map(
        (_, index): BacklogIngestEntryResult => ({
          index,
          id: `blc_${index}`,
          outcome: 'published',
          code: null
        })
      )
    }
  }
  return { port, chunks }
}

function runnerOver(source: BacklogConversationSource, service: HarvestIngestPort) {
  return createBacklogHarvestRunner({ service, sources: { conversations: () => source } })
}

describe('Orca conversation harvest outcomes', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-harvest-conv-'))
    fault.failFrom = null
    fault.calls = 0
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('names every non-loaded outcome instead of reporting an empty source', async () => {
    const conversations = join(dir, 'conversations')
    mkdirSync(conversations)
    const write = (id: string, body: string) => writeFileSync(join(conversations, `${id}.json`), body)
    write('conv_loaded', JSON.stringify(recordOf('conv_loaded', ['- [ ] keep me'])))
    write('conv_torn', '{"schemaVersion": 1, "id": "conv_to')
    write('conv_newer', JSON.stringify(recordOf('conv_newer', ['x'], { schemaVersion: 2 })))
    write('conv_vanish', JSON.stringify(recordOf('conv_vanish', ['- [ ] gone'])))
    const store = conversationSourceFromStore(new ConversationStore(conversations))
    const vanishing: BacklogConversationSource = {
      listIds: store.listIds,
      read: async (id) => {
        if (id === 'conv_vanish') {
          unlinkSync(join(conversations, 'conv_vanish.json'))
        }
        return store.read(id)
      }
    }
    const service = new BacklogService(() => join(dir, 'backlog'))

    const report = await runnerOver(vanishing, service).run('orca-conversations')

    expect(report).toMatchObject({
      outcome: 'completed',
      seen: 4,
      read: 1,
      candidatesNew: 1,
      skipped: { unreadable: 1, 'schema-too-new': 1, vanished: 1 },
      cap: null
    })
  })

  it('refuses the run when listing fails, and reads a missing directory as a measured zero', async () => {
    const { port, chunks } = publishingPort()
    const denied: BacklogConversationSource = {
      listIds: async () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      },
      read: async () => ({ outcome: 'absent' })
    }
    const refused = await runnerOver(denied, port).run('orca-conversations')
    expect(refused).toMatchObject({ outcome: 'refused', code: 'source-unreadable' })
    expect(Object.hasOwn(refused, 'seen')).toBe(false)
    expect(chunks).toEqual([])

    const missing = conversationSourceFromStore(new ConversationStore(join(dir, 'nowhere')))
    const empty = await runnerOver(missing, port).run('orca-conversations')
    expect(empty).toMatchObject({ outcome: 'completed', seen: 0, read: 0, candidatesNew: 0 })
  })

  it('reads at most 16 records at once, and more than one', async () => {
    const records = new Map(
      Array.from({ length: 40 }, (_, index) => {
        const id = `conv_${String(index).padStart(3, '0')}`
        return [id, recordOf(id, ['hello'])] as const
      })
    )
    const counted = memorySource(records)
    await runnerOver(counted.source, publishingPort().port).run('orca-conversations')
    expect(counted.reads).toHaveLength(40)
    expect(counted.maxInFlight()).toBeLessThanOrEqual(16)
    expect(counted.maxInFlight()).toBeGreaterThanOrEqual(2)
  })

  it('reads the first 2,000 conversations by id and names the cap; 2,000 exactly is no cap', async () => {
    const ids = Array.from({ length: 2_001 }, (_, index) => `conv_${String(index).padStart(5, '0')}`)
    const records = new Map(ids.map((id) => [id, recordOf(id, ['hello'])] as const))
    const over = memorySource(records, [...ids].reverse())
    const capped = await runnerOver(over.source, publishingPort().port).run('orca-conversations')
    expect(capped).toMatchObject({
      outcome: 'completed',
      seen: 2_001,
      read: 2_000,
      cap: { code: 'sources-per-run', notScanned: 1, kept: 'first-by-id' }
    })
    expect(over.reads).not.toContain(ids.at(-1))
    expect(over.reads).toContain(ids[0])

    records.delete(ids.at(-1)!)
    const exact = memorySource(records)
    const uncapped = await runnerOver(exact.source, publishingPort().port).run('orca-conversations')
    expect(uncapped).toMatchObject({ outcome: 'completed', read: 2_000, cap: null })
  })

  it('sends at most 1,000 candidates per run in chunks of 1..200 and names the cap', async () => {
    const records = new Map(
      Array.from({ length: 60 }, (_, index) => {
        const id = `conv_${String(index).padStart(2, '0')}`
        return [id, recordOf(id, [markers(20, id)])] as const
      })
    )
    const { port, chunks } = publishingPort()
    const report = await runnerOver(memorySource(records).source, port).run('orca-conversations')
    expect(report).toMatchObject({
      outcome: 'completed',
      candidatesNew: 1_000,
      cap: { code: 'candidates-per-run', notScanned: 200, kept: 'first-by-id' }
    })
    expect(chunks.every((length) => length >= 1 && length <= 200)).toBe(true)
    expect(chunks.reduce((sum, length) => sum + length, 0)).toBe(1_000)
  })

  it('stops on a storage failure in the second chunk and reports the counts reached', async () => {
    const records = new Map(
      Array.from({ length: 21 }, (_, index) => {
        const id = `conv_${String(index).padStart(2, '0')}`
        return [id, recordOf(id, [markers(20, id)])] as const
      })
    )
    const service = new BacklogService(() => join(dir, 'backlog'))
    const ingest = vi.spyOn(service, 'ingestCandidates')
    fault.failFrom = 201

    const report = await runnerOver(memorySource(records).source, service).run('orca-conversations')

    expect(report).toMatchObject({
      outcome: 'failed',
      stage: 'publish',
      code: 'EIO',
      seen: 21,
      read: 21,
      candidatesNew: 200
    })
    expect(ingest.mock.calls.map(([entries]) => entries.length)).toEqual([200, 200])
  })

  it('counts a refused ingest entry and still completes', async () => {
    const record = recordOf('conv_nul', ['- [ ] fine line'])
    const bad = { ...record.messages[0], id: 'bad\0id', seq: 0 }
    const withNul = { ...record, messages: [bad, ...record.messages] }
    const service = new BacklogService(() => join(dir, 'backlog'))
    const source = memorySource(new Map([['conv_nul', withNul]])).source

    const report = await runnerOver(source, service).run('orca-conversations')

    expect(report).toMatchObject({
      outcome: 'completed',
      candidatesNew: 1,
      candidatesFailed: { 'invalid-record': 1 }
    })
  })

  it('counts an unanswered last turn that is still working as turn-unsettled', async () => {
    const records = new Map([
      ['conv_busy', recordOf('conv_busy', ['please ship it'], { turnState: 'working', answered: false })],
      ['conv_done', recordOf('conv_done', ['please ship it'], { answered: false })]
    ])
    const report = await runnerOver(memorySource(records).source, publishingPort().port).run(
      'orca-conversations'
    )
    expect(report).toMatchObject({
      outcome: 'completed',
      candidatesNew: 1,
      skipped: { 'turn-unsettled': 1 }
    })
  })
})
