import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { BACKLOG_RUNTIME_CAPABILITY, RUNTIME_CAPABILITIES } from '../../../../shared/protocol-version'
import { createCompatibleRuntimeStatusResponse } from '../../runtime/runtime-compatibility-test-fixture'
import { RUNTIME_COMPAT_BLOCK_CODE } from '../../runtime/runtime-protocol-compat'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import type { BacklogItem } from '../../../../shared/backlog-types'
import { toBacklogItemSummary } from '../../../../shared/backlog-summary'
import { getBacklogItem, listBacklogPage, readBacklogHealth } from './backlog-client'
import {
  captureBacklogItem,
  transitionBacklogItem,
  updateBacklogItem
} from './backlog-mutation-client'

const localCall = vi.fn()
const environmentCall = vi.fn()
const LOCAL = { activeRuntimeEnvironmentId: null }
const REMOTE = { activeRuntimeEnvironmentId: 'env-1' }
const ID = 'bli_00000000-0000-4000-8000-000000000001'

// Every outcome built in this suite; the last test walks them for a renderable message field.
const built: unknown[] = []
const keep = <T>(outcome: T): T => {
  built.push(outcome)
  return outcome
}

function item(text = 'hello'): BacklogItem {
  return {
    schemaVersion: 1,
    id: ID,
    kind: 'idea',
    originalText: text,
    normalizedIntent: 'hello',
    projectRefs: [],
    state: 'needs-triage',
    priority: 'normal',
    dependencies: [],
    executorPolicy: null,
    sourceLinks: [],
    executionLinks: [],
    evidence: [],
    events: [{ id: 'e1', type: 'created', at: 1, data: {} }],
    mergedInto: null,
    revision: 1,
    createdAt: 1,
    updatedAt: 1
  }
}

const ok = (result: unknown) => ({ id: 'r', ok: true, result, _meta: { runtimeId: 'local' } })
const fail = (code: string) => ({
  id: 'r',
  ok: false,
  error: { code, message: `raw transport text ${code}` }
})

function statusWith(backlog: boolean) {
  const response = createCompatibleRuntimeStatusResponse()
  if (!response.ok) {
    throw new Error('fixture status is not ok')
  }
  // backlog.v1 is runtime-conditional, so the static list never carries it.
  const capabilities: string[] = [...RUNTIME_CAPABILITIES]
  expect(capabilities).not.toContain(BACKLOG_RUNTIME_CAPABILITY)
  return {
    ...response,
    result: {
      ...response.result,
      capabilities: backlog ? [...capabilities, BACKLOG_RUNTIME_CAPABILITY] : capabilities
    }
  }
}

function remoteHost(backlog: boolean, answer: (method: string) => unknown) {
  environmentCall.mockImplementation(async (args: { method: string }) =>
    args.method === 'status.get' ? statusWith(backlog) : answer(args.method)
  )
}

const backlogCalls = (mock: ReturnType<typeof vi.fn>) =>
  mock.mock.calls.filter(([args]) => String(args.method).startsWith('backlog.'))

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  localCall.mockReset()
  environmentCall.mockReset()
  vi.stubGlobal('window', {
    api: { runtime: { call: localCall }, runtimeEnvironments: { call: environmentCall } }
  })
})

afterAll(() => {
  vi.unstubAllGlobals()
})

describe('backlog client targets', () => {
  it('calls the local runtime with no capability pre-check and asks for summary rows', async () => {
    localCall.mockResolvedValue(
      ok({ outcome: 'listed', view: 'summary', items: [], total: 0, nextCursor: null, quarantinedCount: 0 })
    )
    const page = keep(await listBacklogPage(LOCAL, { cursor: null, limit: 100 }))
    expect(page).toMatchObject({ status: 'ok', hostView: 'summary', total: 0 })
    expect(localCall).toHaveBeenCalledWith({
      method: 'backlog.list',
      params: { view: 'summary', limit: 100 }
    })
    expect(environmentCall).not.toHaveBeenCalled()
  })

  it('refuses an environment without backlog.v1 before any backlog call', async () => {
    remoteHost(false, () => ok({}))
    expect(keep(await listBacklogPage(REMOTE, { cursor: null, limit: 100 }))).toEqual({
      status: 'capability-unsupported'
    })
    expect(
      keep(await captureBacklogItem(REMOTE, { text: 'x', kind: 'idea' }))
    ).toEqual({ status: 'capability-unsupported' })
    expect(backlogCalls(environmentCall)).toHaveLength(0)
    expect(localCall).not.toHaveBeenCalled()
  })

  it('proceeds on an environment that advertises backlog.v1', async () => {
    remoteHost(true, () => ok({ outcome: 'loaded', record: item() }))
    expect(keep(await getBacklogItem(REMOTE, ID))).toEqual({ status: 'loaded', item: item() })
    expect(backlogCalls(environmentCall)).toHaveLength(1)
  })

  it('answers unreachable when the capability probe throws', async () => {
    environmentCall.mockRejectedValue(new Error('socket closed'))
    expect(keep(await readBacklogHealth(REMOTE))).toEqual({ status: 'unreachable' })
    expect(keep(await transitionBacklogItem(REMOTE, ID, 'ready'))).toEqual({
      status: 'unreachable'
    })
  })
})

describe('backlog client read classification', () => {
  it('maps host error codes to closed outcomes', async () => {
    for (const [code, status] of [
      ['method_not_found', 'capability-unsupported'],
      ['capability_unsupported', 'capability-unsupported'],
      ['forbidden', 'forbidden'],
      ['invalid_argument', 'unreachable'],
      ['internal_error', 'unreachable']
    ]) {
      localCall.mockResolvedValue(fail(code))
      expect(keep(await readBacklogHealth(LOCAL)), code).toEqual({ status })
    }
    localCall.mockRejectedValue(new Error('ipc gone'))
    expect(keep(await listBacklogPage(LOCAL, { cursor: '100', limit: 500 }))).toEqual({
      status: 'unreachable'
    })
  })

  it('passes a storage failure through as stage and code', async () => {
    localCall.mockResolvedValue(ok({ outcome: 'storage-failed', stage: 'scan', code: 'EACCES' }))
    expect(keep(await listBacklogPage(LOCAL, { cursor: null, limit: 100 }))).toEqual({
      status: 'storage-failed',
      stage: 'scan',
      code: 'EACCES'
    })
  })

  it('normalizes rows, reads the echo, and treats an absent echo as full', async () => {
    const full = item('x'.repeat(2_500))
    localCall.mockResolvedValue(
      ok({ outcome: 'listed', items: [full], total: 1, nextCursor: null, quarantinedCount: 2 })
    )
    const page = keep(await listBacklogPage(LOCAL, { cursor: null, limit: 100 }))
    expect(page).toEqual({
      status: 'ok',
      rows: [toBacklogItemSummary(full)],
      hostView: 'full',
      total: 1,
      nextCursor: null,
      quarantinedCount: 2
    })
  })

  it('reads health without the quarantine reason text', async () => {
    const report = {
      outcome: 'opened',
      items: { total: 0, byState: {} },
      candidates: { total: 0, byStatus: {} },
      quarantined: [
        { recordKind: 'item', fileName: 'x.json', id: null, code: 'not-json', reason: 'raw' }
      ]
    }
    localCall.mockResolvedValue(ok(report))
    const health = keep(await readBacklogHealth(LOCAL))
    expect(health).toEqual({
      status: 'ok',
      report: {
        ...report,
        quarantined: [{ recordKind: 'item', fileName: 'x.json', id: null, code: 'not-json' }]
      }
    })
  })

  it('maps every get outcome', async () => {
    const answers: [unknown, unknown][] = [
      [{ outcome: 'absent' }, { status: 'absent' }],
      [
        { outcome: 'unreadable', code: 'not-json', reason: 'raw' },
        { status: 'unreadable', code: 'not-json' }
      ],
      [{ outcome: 'schema-too-new', storedVersion: 9 }, { status: 'schema-too-new', storedVersion: 9 }]
    ]
    for (const [answer, expected] of answers) {
      localCall.mockResolvedValue(ok(answer))
      expect(keep(await getBacklogItem(LOCAL, ID))).toEqual(expected)
    }
  })
})

describe('backlog client write classification', () => {
  const capture = () => captureBacklogItem(LOCAL, { text: 'Ship it', kind: 'idea' })

  it('confirms published and unchanged writes', async () => {
    localCall.mockResolvedValue(ok({ outcome: 'published', record: item() }))
    expect(keep(await capture())).toEqual({ status: 'confirmed', item: item(), unchanged: false })
    localCall.mockResolvedValue(ok({ outcome: 'unchanged', record: item() }))
    expect(keep(await updateBacklogItem(LOCAL, ID, { priority: 'high' }))).toEqual({
      status: 'confirmed',
      item: item(),
      unchanged: true
    })
    expect(localCall).toHaveBeenLastCalledWith({
      method: 'backlog.update',
      params: { id: ID, patch: { priority: 'high' } }
    })
  })

  it('maps refusals, the revision fence and store outcomes', async () => {
    const answers: [unknown, unknown][] = [
      [
        { outcome: 'refused', code: 'illegal-transition', detail: 'raw' },
        { status: 'refused', code: 'illegal-transition' }
      ],
      [{ outcome: 'superseded', expectedRevision: 1, actualRevision: 2 }, { status: 'stale' }],
      [{ outcome: 'absent' }, { status: 'absent' }],
      [
        { outcome: 'unreadable', code: 'too-large', reason: 'raw' },
        { status: 'unreadable', code: 'too-large' }
      ],
      [{ outcome: 'schema-too-new', storedVersion: 3 }, { status: 'schema-too-new', storedVersion: 3 }],
      [
        { outcome: 'storage-failed', stage: 'barrier', code: null },
        { status: 'storage-failed', stage: 'barrier', code: null }
      ]
    ]
    for (const [answer, expected] of answers) {
      localCall.mockResolvedValue(ok(answer))
      expect(keep(await transitionBacklogItem(LOCAL, ID, 'done'))).toEqual(expected)
    }
  })

  it('maps host error codes and throws', async () => {
    for (const [code, expected] of [
      ['invalid_argument', { status: 'refused', code: 'invalid-params' }],
      ['method_not_found', { status: 'capability-unsupported' }],
      ['capability_unsupported', { status: 'capability-unsupported' }],
      ['forbidden', { status: 'forbidden' }],
      ['internal_error', { status: 'unknown' }]
    ] as const) {
      localCall.mockResolvedValue(fail(code))
      expect(keep(await capture()), code).toEqual(expected)
    }
    const blocked = Object.assign(new Error('version block'), { code: RUNTIME_COMPAT_BLOCK_CODE })
    localCall.mockRejectedValue(blocked)
    expect(keep(await capture())).toEqual({ status: 'unreachable' })
  })

  it('never re-sends a capture whose transport failed after the request left', async () => {
    localCall.mockRejectedValue(new Error('reply lost'))
    expect(keep(await capture())).toEqual({ status: 'unknown' })
    expect(localCall.mock.calls.filter(([args]) => args.method === 'backlog.capture')).toHaveLength(
      1
    )
  })

  it('sends only the editable patch keys', async () => {
    localCall.mockResolvedValue(ok({ outcome: 'published', record: item() }))
    const patch = { normalizedIntent: 'n', revision: 9 } as unknown as Parameters<
      typeof updateBacklogItem
    >[2]
    keep(await updateBacklogItem(LOCAL, ID, patch))
    expect(localCall).toHaveBeenLastCalledWith({
      method: 'backlog.update',
      params: { id: ID, patch: { normalizedIntent: 'n' } }
    })
  })
})

describe('backlog client outcomes', () => {
  it('carry no renderable message, reason or error field', () => {
    expect(built.length).toBeGreaterThan(20)
    const forbidden = new Set(['message', 'reason', 'error', 'detail'])
    // Ledger records are user data, not failure text; the walk covers every envelope field.
    const skip = new Set(['item', 'rows'])
    const walk = (value: unknown, path: string): void => {
      if (!value || typeof value !== 'object') {
        return
      }
      for (const [key, child] of Object.entries(value)) {
        expect(forbidden.has(key), `${path}.${key}`).toBe(false)
        if (!skip.has(key)) {
          walk(child, `${path}.${key}`)
        }
      }
    }
    built.forEach((outcome, index) => walk(outcome, `outcome[${index}]`))
  })
})
