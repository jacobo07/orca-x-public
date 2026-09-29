// Tracer proof: a capture over the real RpcDispatcher (default method list, so registration in
// index.ts is exercised) publishes a file that a fresh runtime reads back over RPC.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { isBacklogItemId } from '../../../../shared/backlog-identity'
import { createBacklogHost } from '../../../backlog/backlog-host'
import { BacklogService } from '../../../backlog/backlog-service'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'

function request(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

function dispatcherOn(root: string): RpcDispatcher {
  const runtime = new OrcaRuntimeService()
  runtime.setBacklogHost(createBacklogHost(new BacklogService(() => root)))
  return new RpcDispatcher({ runtime })
}

async function resultOf(dispatcher: RpcDispatcher, method: string, params: unknown) {
  const response = await dispatcher.dispatch(request(method, params))
  if (!response.ok) {
    throw new Error(`${method} failed: ${response.error.message}`)
  }
  return response.result as { outcome: string; record?: Record<string, unknown> & { id: string } }
}

describe('backlog runtime RPC round trip', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-backlog-rpc-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('captures over RPC and a fresh runtime reads the same record back', async () => {
    const captured = await resultOf(dispatcherOn(root), 'backlog.capture', {
      text: 'Ship the intent ledger',
      kind: 'engineering',
      revision: 99,
      id: 'bli_forged',
      events: []
    })

    expect(captured.outcome).toBe('published')
    const record = captured.record!
    expect(isBacklogItemId(record.id)).toBe(true)
    expect(record.id).not.toBe('bli_forged')
    expect(record.revision).toBe(1)
    expect(record.projectRefs).toEqual([])
    expect((record.events as { type: string }[]).map((event) => event.type)).toEqual(['created'])
    expect(existsSync(join(root, 'items', `${record.id}.json`))).toBe(true)

    const loaded = await resultOf(dispatcherOn(root), 'backlog.get', { id: record.id })
    expect(loaded).toEqual({ outcome: 'loaded', record })
  })

  it('answers absent for a well-formed id that was never captured', async () => {
    const loaded = await resultOf(dispatcherOn(root), 'backlog.get', {
      id: 'bli_00000000-0000-4000-8000-000000000000'
    })
    expect(loaded).toEqual({ outcome: 'absent' })
  })

  it('updates and transitions to done over RPC; a fresh runtime reads 4 events', async () => {
    const dispatcher = dispatcherOn(root)
    const captured = await resultOf(dispatcher, 'backlog.capture', {
      text: 'Land the fence',
      kind: 'engineering'
    })
    const id = captured.record!.id
    const evidence = (subject: string) => ({
      class: 'OBSERVED',
      origin: 'tool',
      subject,
      source: 'ci',
      ref: 'abc123'
    })

    const updated = await resultOf(dispatcher, 'backlog.update', {
      id,
      patch: { addEvidence: [evidence('revision'), evidence('gate')] }
    })
    expect(updated.outcome).toBe('published')
    expect((await resultOf(dispatcher, 'backlog.transition', { id, to: 'ready' })).outcome).toBe(
      'published'
    )
    const done = await resultOf(dispatcher, 'backlog.transition', { id, to: 'done' })
    expect(done.outcome).toBe('published')

    const reloaded = await resultOf(dispatcherOn(root), 'backlog.get', { id })
    expect(reloaded.outcome).toBe('loaded')
    expect(reloaded.record!.state).toBe('done')
    expect((reloaded.record!.events as { type: string }[]).map((event) => event.type)).toEqual([
      'created',
      'updated',
      'transitioned',
      'transitioned'
    ])
    expect(reloaded).toEqual({ outcome: 'loaded', record: done.record })
  })

  it('surfaces the store’s refusal of model-origin PROVEN evidence through the dispatcher', async () => {
    const dispatcher = dispatcherOn(root)
    const captured = await resultOf(dispatcher, 'backlog.capture', { text: 'x', kind: 'research' })

    const refused = await resultOf(dispatcher, 'backlog.update', {
      id: captured.record!.id,
      patch: {
        addEvidence: [{ class: 'PROVEN', origin: 'model', subject: 'artifact', source: 'llm', ref: null }]
      }
    })

    expect(refused).toMatchObject({ outcome: 'refused', code: 'model-evidence-proven' })
  })

  it('ingests, accepts and merges candidates; a fresh runtime reads the provenance', async () => {
    const dispatcher = dispatcherOn(root)
    const source = (ref: string) => ({
      kind: 'codex-transcript',
      ref,
      capturedAt: 9,
      adapter: 'codex-transcripts',
      capabilityLevel: 'bounded'
    })
    const hinted = {
      source: source('run-1'),
      fingerprint: 'fp-1',
      text: 'Add a backlog rail',
      uncertainty: 'medium',
      projectHint: { projectId: 'orca', evidence: 'cwd' }
    }
    const plain = { source: source('run-2'), fingerprint: 'fp-2', text: 'Same idea', uncertainty: 'high' }
    const rows = (await resultOf(dispatcher, 'backlog.candidates.ingest', {
      candidates: [hinted, plain]
    })) as unknown as { id: string; outcome: string }[]
    expect(rows.map((row) => row.outcome)).toEqual(['published', 'published'])
    const [hintedId, plainId] = rows.map((row) => row.id)

    const again = (await resultOf(dispatcher, 'backlog.candidates.ingest', {
      candidates: [hinted]
    })) as unknown as { outcome: string }[]
    expect(again[0].outcome).toBe('unchanged')

    const accepted = (await resultOf(dispatcher, 'backlog.candidates.resolve', {
      action: 'accept',
      candidateId: hintedId
    })) as unknown as { item: { outcome: string; record: { id: string } } }
    expect(accepted.item.outcome).toBe('published')
    const itemId = accepted.item.record.id
    const merged = (await resultOf(dispatcher, 'backlog.candidates.resolve', {
      action: 'merge',
      candidateId: plainId,
      itemId
    })) as unknown as { candidate: { outcome: string }; item: { outcome: string } }
    expect([merged.item.outcome, merged.candidate.outcome]).toEqual(['published', 'published'])

    const fresh = new BacklogService(() => root)
    const reloaded = await fresh.get(itemId)
    if (reloaded.outcome !== 'loaded') {
      throw new Error(`fresh read returned ${reloaded.outcome}`)
    }
    expect(reloaded.record.sourceLinks.map((link) => link.candidateId)).toEqual([hintedId, plainId])
    expect(reloaded.record.projectRefs).toEqual([
      { projectId: 'orca', mapping: 'inferred', evidence: 'cwd' }
    ])
    const settled = (await resultOf(dispatcherOn(root), 'backlog.candidates.resolve', {
      action: 'merge',
      candidateId: plainId,
      itemId
    })) as unknown as { candidate: { outcome: string; record: { status: string } } }
    expect(settled.candidate).toMatchObject({ outcome: 'unchanged', record: { status: 'merged' } })
    const hintedAgain = (await resultOf(dispatcherOn(root), 'backlog.candidates.resolve', {
      action: 'accept',
      candidateId: hintedId
    })) as unknown as { candidate: { outcome: string; record: { status: string } } }
    expect(hintedAgain.candidate).toMatchObject({
      outcome: 'unchanged',
      record: { status: 'accepted' }
    })
  })

  it('merges two items over RPC; a fresh runtime reads the loser superseded', async () => {
    const dispatcher = dispatcherOn(root)
    const survivor = (await resultOf(dispatcher, 'backlog.capture', { text: 'Keep', kind: 'idea' }))
      .record!
    const loser = (await resultOf(dispatcher, 'backlog.capture', { text: 'Fold', kind: 'idea' }))
      .record!

    const result = (await resultOf(dispatcher, 'backlog.merge', {
      survivorId: survivor.id,
      loserId: loser.id
    })) as unknown as { survivor: { outcome: string }; loser: { outcome: string } }
    expect([result.survivor.outcome, result.loser.outcome]).toEqual(['published', 'published'])

    const fresh = dispatcherOn(root)
    const gone = await resultOf(fresh, 'backlog.get', { id: loser.id })
    expect(gone.record).toMatchObject({ state: 'superseded', mergedInto: survivor.id })
    const kept = await resultOf(fresh, 'backlog.get', { id: survivor.id })
    expect((kept.record!.sourceLinks as { kind: string; ref: string }[])).toEqual([
      expect.objectContaining({ kind: 'manual', ref: survivor.id }),
      expect.objectContaining({ kind: 'manual', ref: loser.id })
    ])
  })

  it('lists, pages and reports health over RPC from a fresh runtime', async () => {
    const writer = dispatcherOn(root)
    const inP = { projectId: 'P', mapping: 'explicit', evidence: 'test' }
    for (const params of [
      { text: 'one', kind: 'engineering', projectRefs: [inP] },
      { text: 'two', kind: 'idea', projectRefs: [inP] },
      { text: 'three', kind: 'idea' }
    ]) {
      expect((await resultOf(writer, 'backlog.capture', params)).outcome).toBe('published')
    }
    const source = (ref: string) => ({
      kind: 'orca-conversation',
      ref,
      capturedAt: 3,
      adapter: 'orca-conversations',
      capabilityLevel: 'full'
    })
    const rows = (await resultOf(writer, 'backlog.candidates.ingest', {
      candidates: [
        { source: source('a'), fingerprint: 'fa', text: 'keep open', uncertainty: 'low' },
        { source: source('b'), fingerprint: 'fb', text: 'dismiss me', uncertainty: 'low' }
      ]
    })) as unknown as { id: string }[]
    await resultOf(writer, 'backlog.candidates.resolve', {
      action: 'dismiss',
      candidateId: rows[1].id
    })
    writeFileSync(join(root, 'items', 'bli_00000000-0000-4000-8000-0000000000ff.json'), '{"trunc')

    type Listed = { total: number; items: { id: string }[]; nextCursor: string | null }
    const reader = dispatcherOn(root)
    const list = (params: unknown) =>
      resultOf(reader, 'backlog.list', params) as unknown as Promise<Listed & { quarantinedCount: number }>
    expect(await list({ unassigned: true })).toMatchObject({ total: 1, quarantinedCount: 1 })
    expect(await list({ projectId: 'P' })).toMatchObject({ total: 2 })
    const first = await list({ limit: 2 })
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()
    const rest = await list({ limit: 2, cursor: first.nextCursor })
    expect(rest).toMatchObject({ total: 3, nextCursor: null })
    expect(new Set([...first.items, ...rest.items].map((item) => item.id)).size).toBe(3)

    const health = (await resultOf(reader, 'backlog.health', undefined)) as unknown as {
      items: { byState: Record<string, number> }
      quarantined: { code: string; recordKind: string }[]
    }
    expect(health.quarantined).toEqual([
      expect.objectContaining({ recordKind: 'item', code: 'not-json' })
    ])
    expect(Object.values(health.items.byState).reduce((sum, count) => sum + count, 0)).toBe(3)
    const byKind = health.items as unknown as {
      byKind: Record<string, number>
      openByKind: Record<string, number>
    }
    expect(byKind.byKind).toEqual({ engineering: 1, research: 0, decision: 0, manual: 0, idea: 2 })
    expect(byKind.openByKind).toEqual(byKind.byKind)
    const open = (await resultOf(reader, 'backlog.candidates.list', {
      status: 'open'
    })) as unknown as { total: number; candidates: { id: string }[] }
    expect(open.total).toBe(1)
    expect(open.candidates.map((row) => row.id)).toEqual([rows[0].id])
  })

  it('serves summary rows with an echo to a fresh runtime; full stays the default', async () => {
    const writer = dispatcherOn(root)
    for (const text of ['short one', 'L'.repeat(2_500)]) {
      expect((await resultOf(writer, 'backlog.capture', { text, kind: 'idea' })).outcome).toBe(
        'published'
      )
    }

    type Row = Record<string, unknown> & { originalText: string }
    type Listed = { outcome: string; view: string; items: Row[] }
    const summary = (await resultOf(dispatcherOn(root), 'backlog.list', {
      view: 'summary'
    })) as unknown as Listed
    expect(summary).toMatchObject({ outcome: 'listed', view: 'summary' })
    expect(summary.items).toHaveLength(2)
    for (const row of summary.items) {
      expect(Object.hasOwn(row, 'events')).toBe(false)
      expect(Object.hasOwn(row, 'evidence')).toBe(false)
    }
    const long = summary.items.find((row) => row.originalText.startsWith('L'))!
    expect(long.originalText).toBe('L'.repeat(2_000))
    expect(long.textTruncated).toBe(true)
    const short = summary.items.find((row) => row.originalText === 'short one')!
    expect(Object.hasOwn(short, 'textTruncated')).toBe(false)

    const full = (await resultOf(dispatcherOn(root), 'backlog.list', {})) as unknown as Listed
    expect(full).toMatchObject({ outcome: 'listed', view: 'full' })
    expect(full.items.every((row) => Array.isArray(row.events))).toBe(true)

    const refused = await dispatcherOn(root).dispatch(request('backlog.list', { view: 'compact' }))
    expect(refused.ok).toBe(false)
    expect(!refused.ok && refused.error.code).toBe('invalid_argument')
  })
})
