import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { toBacklogItemSummary } from '../../../../shared/backlog-summary'
import type { BacklogItem } from '../../../../shared/backlog-types'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { loadBacklogSnapshot } from './backlog-snapshot'

const localCall = vi.fn()
const LOCAL = { activeRuntimeEnvironmentId: null }

function item(n: number): BacklogItem {
  return {
    schemaVersion: 1,
    id: `bli_00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`,
    kind: 'idea',
    originalText: `text ${n}`,
    normalizedIntent: `intent ${n}`,
    projectRefs: [],
    state: 'needs-triage',
    priority: 'normal',
    dependencies: [],
    executorPolicy: null,
    sourceLinks: [],
    executionLinks: [],
    evidence: [],
    events: [{ id: `e${n}`, type: 'created', at: n, data: {} }],
    mergedInto: null,
    revision: 1,
    createdAt: n,
    updatedAt: n
  }
}

type Page = { items: unknown[]; nextCursor: string | null; total: number; view?: string }

function answerPages(pages: Page[]) {
  let index = 0
  localCall.mockImplementation(async () => {
    const page = pages[index]
    index += 1
    return {
      id: 'r',
      ok: true,
      result: { outcome: 'listed', quarantinedCount: index, ...page },
      _meta: { runtimeId: 'local' }
    }
  })
}

const sentParams = () =>
  localCall.mock.calls.map(([args]) => (args as { params: Record<string, unknown> }).params)

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  localCall.mockReset()
  vi.stubGlobal('window', { api: { runtime: { call: localCall }, runtimeEnvironments: { call: vi.fn() } } })
})

afterAll(() => {
  vi.unstubAllGlobals()
})

describe('loadBacklogSnapshot', () => {
  it('pages 100 then 500 when the host echoes summary, to nextCursor null', async () => {
    const summary = (n: number) => toBacklogItemSummary(item(n))
    answerPages([
      { view: 'summary', items: [summary(1), summary(2)], nextCursor: '100', total: 4 },
      { view: 'summary', items: [summary(3)], nextCursor: '600', total: 4 },
      { view: 'summary', items: [summary(4)], nextCursor: null, total: 5 }
    ])
    const loaded = await loadBacklogSnapshot(LOCAL)
    expect(sentParams()).toEqual([
      { view: 'summary', limit: 100 },
      { view: 'summary', limit: 500, cursor: '100' },
      { view: 'summary', limit: 500, cursor: '600' }
    ])
    expect(loaded).toEqual({
      status: 'ready',
      rows: [summary(1), summary(2), summary(3), summary(4)],
      ledgerTotal: 5,
      hostView: 'summary',
      quarantinedItems: 3
    })
  })

  it('stays at 100 and normalizes full rows when the host omits the echo', async () => {
    answerPages([
      { items: [item(1)], nextCursor: '100', total: 2 },
      { items: [item(2)], nextCursor: null, total: 2 }
    ])
    const loaded = await loadBacklogSnapshot(LOCAL)
    expect(sentParams().map((params) => params.limit)).toEqual([100, 100])
    expect(sentParams()[0].view).toBe('summary')
    expect(loaded).toMatchObject({ status: 'ready', hostView: 'full', ledgerTotal: 2 })
    expect(loaded.status === 'ready' && loaded.rows).toEqual([
      toBacklogItemSummary(item(1)),
      toBacklogItemSummary(item(2))
    ])
  })

  it('keeps one row per id across pages', async () => {
    answerPages([
      { view: 'summary', items: [item(1), item(2)], nextCursor: '2', total: 3 },
      { view: 'summary', items: [item(2), item(3)], nextCursor: null, total: 3 }
    ])
    const loaded = await loadBacklogSnapshot(LOCAL)
    expect(loaded.status === 'ready' && loaded.rows.map((row) => row.id)).toEqual([
      item(1).id,
      item(2).id,
      item(3).id
    ])
  })

  it('returns a failing page as its closed failure, never a partial ready', async () => {
    let calls = 0
    localCall.mockImplementation(async () => {
      calls += 1
      return calls === 1
        ? {
            id: 'r',
            ok: true,
            result: {
              outcome: 'listed',
              view: 'summary',
              items: [item(1)],
              total: 2,
              nextCursor: '100',
              quarantinedCount: 0
            },
            _meta: { runtimeId: 'local' }
          }
        : { id: 'r', ok: true, result: { outcome: 'storage-failed', stage: 'scan', code: null } }
    })
    expect(await loadBacklogSnapshot(LOCAL)).toEqual({
      status: 'storage-failed',
      stage: 'scan',
      code: null
    })
    localCall.mockReset()
    localCall.mockResolvedValue({ id: 'r', ok: false, error: { code: 'forbidden', message: 'no' } })
    expect(await loadBacklogSnapshot(LOCAL)).toEqual({ status: 'forbidden' })
  })

  it('ends unreachable when the cursor does not advance', async () => {
    answerPages([
      { view: 'summary', items: [item(1)], nextCursor: '100', total: 9 },
      { view: 'summary', items: [item(2)], nextCursor: '100', total: 9 }
    ])
    expect(await loadBacklogSnapshot(LOCAL)).toEqual({ status: 'unreachable' })
    expect(localCall).toHaveBeenCalledTimes(2)
  })
})
