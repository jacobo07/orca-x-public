import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ConversationRecord } from '../../../shared/conversation-types'
import type { BacklogIngestEntryResult } from '../backlog-candidate-operations'
import { BacklogService } from '../backlog-service'
import type { BacklogTranscriptSource } from './ai-vault-transcript-harvest'
import { createBacklogHarvestRunner, type BacklogHarvestSources } from './backlog-harvest-runner'
import type { HarvestIngestPort } from './harvest-ingest-pipeline'
import type { BacklogConversationSource } from './orca-conversation-harvest'

function deferred() {
  let release: () => void = () => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

function recordOf(id: string): ConversationRecord {
  return {
    schemaVersion: 1,
    id,
    title: 't',
    createdAt: 1,
    updatedAt: 2,
    status: 'active',
    projectId: null,
    provenance: [],
    turns: [{ turnId: 't1', seq: 0, state: 'completed', startedAt: 1, endedAt: 2 }],
    messages: [
      {
        id: 'm1',
        seq: 1,
        role: 'user',
        blocks: [{ type: 'text', text: '- [ ] keep the registry honest' }],
        timestamp: 1,
        turnId: 't1'
      },
      { id: 'm2', seq: 2, role: 'assistant', blocks: [{ type: 'text', text: 'ok' }], timestamp: 2 }
    ],
    nextSeq: 3
  } as ConversationRecord
}

// Every listing is counted; `gate` (when set) holds the listing open until released.
function conversationSource(options: { gate?: Promise<void>; throws?: boolean } = {}) {
  let lists = 0
  const source: BacklogConversationSource = {
    listIds: async () => {
      lists += 1
      await options.gate
      if (options.throws) {
        throw new Error('EACCES')
      }
      return ['conv_1']
    },
    read: async (id) => ({ outcome: 'loaded', record: recordOf(id) })
  }
  return { source, lists: () => lists }
}

const noTranscripts: BacklogTranscriptSource = {
  list: async () => ({ sessions: [], issues: [], scannedAt: '' }),
  statBytes: async () => 0,
  readTranscript: async () => ({ messages: [] })
}

function portAnswering(outcome: BacklogIngestEntryResult['outcome'], code: string | null = null) {
  const port: HarvestIngestPort = {
    ingestCandidates: async (entries) =>
      entries.map((_, index) => ({ index, id: `blc_${index}`, outcome, code }))
  }
  return port
}

describe('backlog harvest runner status and single flight', () => {
  let dir: string
  let root: string
  let sources: BacklogHarvestSources
  let port: HarvestIngestPort

  // Late-bound, so a test can swap a source, the port or the root between runs of one runner.
  const runner = () =>
    createBacklogHarvestRunner({
      service: { ingestCandidates: (entries) => port.ingestCandidates(entries) },
      sources: {
        conversations: () => sources.conversations(),
        transcripts: () => sources.transcripts()
      },
      ledgerRoot: () => root
    })
  const statusOf = async (target: ReturnType<typeof runner>) =>
    Object.fromEntries((await target.status()).units.map((row) => [row.unit, row.status]))

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-harvest-runner-'))
    root = join(dir, 'ledger-a')
    sources = { conversations: () => conversationSource().source, transcripts: () => noTranscripts }
    port = portAnswering('published')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads not-run for every unit on a fresh runner even when the ledger holds candidates', async () => {
    const service = new BacklogService(() => root)
    const source = (kind: string, ref: string) => ({
      kind,
      ref,
      capturedAt: 1,
      adapter: 'seed',
      capabilityLevel: 'full'
    })
    const seeded = await service.ingestCandidates(
      (
        [
          'orca-conversation',
          'claude-code-transcript',
          'codex-transcript',
          'chatgpt-export'
        ] as const
      ).map((kind) => ({
        source: source(kind, `${kind}-1`),
        fingerprint: `fp-${kind}`,
        text: `seeded from ${kind}`,
        uncertainty: 'medium' as const
      })) as Parameters<BacklogService['ingestCandidates']>[0]
    )
    expect(seeded.map((row) => row.outcome)).toEqual([
      'published',
      'published',
      'published',
      'published'
    ])
    port = service

    const fresh = runner()
    const report = await fresh.status()
    expect(report.units).toEqual([
      { unit: 'orca-conversations', status: 'not-run', lastReport: null },
      { unit: 'agent-transcripts', status: 'not-run', lastReport: null },
      { unit: 'chatgpt-export', status: 'not-run', lastReport: null }
    ])

    // Positive control: the same runner reads connected after one completed run.
    await fresh.run('orca-conversations')
    const after = await fresh.status()
    expect(after.units[0]).toMatchObject({
      unit: 'orca-conversations',
      status: 'connected',
      lastReport: { outcome: 'completed' }
    })
  })

  it('moves through running, connected, refused, failed and back to connected', async () => {
    const gate = deferred()
    const blocked = conversationSource({ gate: gate.promise })
    sources.conversations = () => blocked.source
    const target = runner()

    const inFlight = target.run('orca-conversations')
    await new Promise((resolve) => setImmediate(resolve))
    expect((await statusOf(target))['orca-conversations']).toBe('running')
    gate.release()
    expect(await inFlight).toMatchObject({ outcome: 'completed' })
    expect((await statusOf(target))['orca-conversations']).toBe('connected')

    sources.conversations = () => conversationSource({ throws: true }).source
    expect(await target.run('orca-conversations')).toMatchObject({ outcome: 'refused' })
    expect((await statusOf(target))['orca-conversations']).toBe('refused')

    sources.conversations = () => conversationSource().source
    port = portAnswering('storage-failed', 'publish:EIO')
    expect(await target.run('orca-conversations')).toMatchObject({ outcome: 'failed' })
    expect((await statusOf(target))['orca-conversations']).toBe('failed')

    port = portAnswering('published')
    expect(await target.run('orca-conversations')).toMatchObject({ outcome: 'completed' })
    expect((await statusOf(target))['orca-conversations']).toBe('connected')
  })

  it('refuses a second run of a running unit without reaching a port; another unit proceeds', async () => {
    const gate = deferred()
    const blocked = conversationSource({ gate: gate.promise })
    sources.conversations = () => blocked.source
    const target = runner()

    const first = target.run('orca-conversations')
    await new Promise((resolve) => setImmediate(resolve))
    const second = await target.run('orca-conversations')
    expect(second).toMatchObject({
      outcome: 'refused',
      unit: 'orca-conversations',
      code: 'already-running'
    })
    expect(blocked.lists()).toBe(1)

    expect(await target.run('agent-transcripts')).toMatchObject({
      outcome: 'completed',
      unit: 'agent-transcripts'
    })
    const statuses = await statusOf(target)
    expect(statuses).toEqual({
      'orca-conversations': 'running',
      'agent-transcripts': 'connected',
      'chatgpt-export': 'not-run'
    })

    gate.release()
    expect(await first).toMatchObject({ outcome: 'completed' })
    expect((await statusOf(target))['orca-conversations']).toBe('connected')
  })

  it('keys status by ledger root, so a profile switch reads not-run again', async () => {
    const target = runner()
    await target.run('orca-conversations')
    expect((await statusOf(target))['orca-conversations']).toBe('connected')

    root = join(dir, 'ledger-b')
    expect(await statusOf(target)).toEqual({
      'orca-conversations': 'not-run',
      'agent-transcripts': 'not-run',
      'chatgpt-export': 'not-run'
    })

    root = join(dir, 'ledger-a')
    expect((await statusOf(target))['orca-conversations']).toBe('connected')
  })

  it('reports a thrown harvester as failed at stage harvest and never sticks at running', async () => {
    sources.conversations = () => {
      throw new Error('boom')
    }
    const target = runner()

    const report = await target.run('orca-conversations')
    expect(report).toEqual({
      outcome: 'failed',
      unit: 'orca-conversations',
      stage: 'harvest',
      code: 'unexpected',
      startedAt: expect.any(Number),
      finishedAt: expect.any(Number)
    })
    expect((await statusOf(target))['orca-conversations']).toBe('failed')

    sources.conversations = () => conversationSource().source
    expect(await target.run('orca-conversations')).toMatchObject({ outcome: 'completed' })
  })

  it('runs an export import through the same single flight and status registry', async () => {
    const target = runner()
    const gate = deferred()
    const first = target.runImport(async () => {
      await gate.promise
      return {
        outcome: 'scanned',
        seen: 1,
        read: 1,
        skipped: {},
        cap: null,
        tally: {
          candidatesNew: 1,
          candidatesDuplicate: 0,
          candidatesFailed: {},
          halted: null,
          cap: null
        }
      }
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect((await statusOf(target))['chatgpt-export']).toBe('running')
    let secondRan = false
    const second = await target.runImport(async () => {
      secondRan = true
      return { outcome: 'refused', code: 'not-json' }
    })
    expect(second).toMatchObject({
      outcome: 'refused',
      unit: 'chatgpt-export',
      code: 'already-running'
    })
    expect(secondRan).toBe(false)

    gate.release()
    expect(await first).toMatchObject({
      outcome: 'completed',
      unit: 'chatgpt-export',
      candidatesNew: 1
    })
    expect((await statusOf(target))['chatgpt-export']).toBe('connected')
  })
})
