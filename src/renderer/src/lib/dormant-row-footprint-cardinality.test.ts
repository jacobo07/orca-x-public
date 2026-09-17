/*
 * R3 logical-density curve: remembering N rows must not cost N runtimes, and its state cost must
 * stay linear with a constant per row.
 *
 * Deterministic by construction (counts and serialized lengths only), so it runs at 100 rows on any
 * host. It speaks for store-altitude state; the process-byte Dormant Session Tax is a separate,
 * host-dependent measurement and this file makes no claim about it.
 *
 * Writes its table to the file named by ORCA_DORMANT_FOOTPRINT_LOG: vitest's config swallows
 * console.info.
 */
import { appendFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { AppState } from '@/store/types'
import { createTestStore, makeWorktree } from '../store/slices/store-test-helpers'
import { createStoreSessionMockApi } from '../store/slices/store-session-test-harness'

const holder = vi.hoisted(() => ({ store: null as null | { getState: () => unknown } }))

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})
vi.mock('@/store', () => ({ useAppStore: { getState: () => holder.store!.getState() } }))
vi.mock('./worktree-runtime-owner', () => ({ getExecutionHostIdForWorktree: () => 'local' }))

const mockApi = createStoreSessionMockApi()
const spawn = vi.fn()
;(mockApi.pty as Record<string, unknown>).spawn = spawn

const { FOOTPRINT_OWNER, measureDormantRowFootprint, captureRail } =
  await import('./dormant-row-footprint-curve-harness')

const SCALES = [1, 10, 50, 100] as const

function emptyWorkspace() {
  const store = createTestStore()
  holder.store = store
  store.setState({
    repos: [
      { id: 'repo-1', path: 'C:/work/orca', displayName: 'Orca', badgeColor: '#000', addedAt: 0 }
    ],
    worktreesByRepo: {
      'repo-1': [makeWorktree({ id: FOOTPRINT_OWNER, repoId: 'repo-1', path: 'C:/work/orca' })]
    },
    activeWorktreeId: 'repo-1::C:/work/elsewhere'
  } as Partial<AppState>)
  let next = 0
  return {
    store,
    newId: () => `00000000-0000-4000-9000-${String(++next).padStart(12, '0')}`
  }
}

const curve = () =>
  SCALES.map((rows) => {
    const { store, newId } = emptyWorkspace()
    return measureDormantRowFootprint(rows, store, newId)
  })

describe('dormant row footprint', () => {
  beforeEach(() => {
    spawn.mockClear()
  })

  it('remembers N rows and materializes none of them', () => {
    for (const point of curve()) {
      // Asked of the real mount authority with no render restriction, so the answer is dormancy's
      // alone: the deferral dissolves (threshold, full reveal, kill switch) and dormancy must not.
      expect({ rows: point.rows, mount: point.wouldMount, dormant: point.dormantRows }).toEqual({
        rows: point.rows,
        mount: 0,
        dormant: point.rows
      })
    }
    expect(spawn).not.toHaveBeenCalled()
  })

  it('arms no recurring producer, at any scale', () => {
    vi.useFakeTimers()
    try {
      for (const rows of SCALES) {
        const { store, newId } = emptyWorkspace()
        const before = vi.getTimerCount()
        measureDormantRowFootprint(rows, store, newId)
        expect(vi.getTimerCount() - before).toBe(0)
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('holds exactly one resume handle per sealed agent pane, and none for the rest', () => {
    for (const point of curve()) {
      expect(point.sleepingRecords).toBe(Math.ceil(point.rows / 2))
    }
  })

  it('costs a constant per row: state and manifest are linear in the remembered set', () => {
    const points = curve()
    const log = process.env.ORCA_DORMANT_FOOTPRINT_LOG
    if (log) {
      appendFileSync(log, `${JSON.stringify(points)}\n`)
    }
    const slopes = points.slice(1).map((point, index) => {
      const previous = points[index]
      const rowDelta = point.rows - previous.rows
      return {
        rows: point.rows,
        stateBytesPerRow: (point.workspaceStateBytes - previous.workspaceStateBytes) / rowDelta,
        manifestBytesPerRow: (point.manifestBytes - previous.manifestBytes) / rowDelta,
        objectsPerRow: (point.storeObjects - previous.storeObjects) / rowDelta
      }
    })
    // Exact, not a slope: one row, one unified tab, one group member and one layout each, plus a
    // resume record for every second row. A superlinear term would break this at the larger points
    // even though the smallest one still fit.
    expect(points.map((point) => point.storeObjects)).toEqual(
      points.map((point) => point.rows * 4 + Math.ceil(point.rows / 2))
    )
    // Bytes carry a per-row constant, so consecutive slopes agree within rounding of the ids.
    const byteSlopes = slopes.map((slope) => slope.stateBytesPerRow)
    expect(Math.max(...byteSlopes) - Math.min(...byteSlopes)).toBeLessThan(
      Math.min(...byteSlopes) * 0.1
    )
    const manifestSlopes = slopes.map((slope) => slope.manifestBytesPerRow)
    expect(Math.max(...manifestSlopes) - Math.min(...manifestSlopes)).toBeLessThan(
      Math.min(...manifestSlopes) * 0.1
    )
  })

  it('projects every remembered row into the manifest, in rail order', () => {
    const manifest = captureRail(100, '00000000-0000-4000-8000-000000000100')
    expect(manifest.entries).toHaveLength(100)
    expect(manifest.railGroups.flat()).toEqual(manifest.entries.map((entry) => entry.tabId))
    // Saving never encodes "wake everything" for a later open.
    expect(manifest.revivalOrder).toEqual([])
  })
})
