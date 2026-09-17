/*
 * The density lab's seed must be something the product would actually have written.
 *
 * A hand-authored manifest tests a shape the producer never emits, and a clone that reuses
 * identities makes two rows claim one session. So the scale seed is proven against all three real
 * consumers in turn: the sealed-manifest reader, the restore planner and the apply step.
 *
 * Altitude: the source here is the real producer over a constructed store. The e2e seed runs the
 * same producer over a genuinely live rail — this file proves the CLONE is faithful, not that the
 * capture is live.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { AppState } from '@/store/types'
import { readProjectWorkingSetManifest } from '../../../shared/project-working-set-schema'
import { cloneWorkingSetToScale } from '../../../shared/project-working-set-scale-clone'
import { isTerminalLeafId } from '../../../shared/stable-pane-id'
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

const { FOOTPRINT_OWNER, captureRail, measureClonedFootprint } =
  await import('./dormant-row-footprint-curve-harness')

const newId = (): string => globalThis.crypto.randomUUID()
/** Two rows is what the e2e can afford to capture live; everything above it is cloned. */
const SOURCE_ROWS = 2
const SCALES = [1, 10, 50] as const

/**
 * One row per rail group. A single-group source cannot express the group-shape claim below — a
 * mutation flattening the rail reads identical against it, which is how that mutation first survived.
 */
const source = () => captureRail(SOURCE_ROWS, newId(), 1)

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
  return store
}

describe('working-set scale clone', () => {
  beforeEach(() => {
    spawn.mockClear()
  })

  it('stays a manifest the sealed reader accepts, at every scale', () => {
    for (const rows of SCALES) {
      const scaled = cloneWorkingSetToScale(source(), rows, { newId })
      // Round-tripped through JSON: the reader's subject is a file, not an object in memory.
      const outcome = readProjectWorkingSetManifest(JSON.parse(JSON.stringify(scaled)))
      expect({ rows, status: outcome.status }).toEqual({ rows, status: 'valid' })
      expect(scaled.entries).toHaveLength(rows)
    }
  })

  it('gives every row and every pane its own identity', () => {
    const scaled = cloneWorkingSetToScale(source(), 50, { newId })
    const tabIds = scaled.entries.map((entry) => entry.tabId)
    const leafIds = scaled.entries.flatMap((entry) => entry.panes.map((pane) => pane.leafId))
    expect(new Set(tabIds).size).toBe(tabIds.length)
    expect(new Set(leafIds).size).toBe(leafIds.length)
    // Canonical UUIDs, not a digit pattern that stops being valid above single digits.
    expect(leafIds.every((leafId) => isTerminalLeafId(leafId))).toBe(true)
    // No clone may claim another row's provider session.
    const sessionIds = scaled.entries
      .flatMap((entry) => entry.panes)
      .flatMap((pane) =>
        pane.resume.kind === 'provider-session' ? [pane.resume.providerSession.id] : []
      )
    expect(sessionIds.length).toBeGreaterThan(0)
    expect(new Set(sessionIds).size).toBe(sessionIds.length)
  })

  it('keeps duplicate labels, so identity cannot be resolved by title', () => {
    const scaled = cloneWorkingSetToScale(source(), 10, { newId })
    const labels = scaled.entries.map((entry) => entry.label)
    expect(new Set(labels).size).toBeLessThan(labels.length)
  })

  it('carries the captured rail shape rather than one flat group', () => {
    const captured = source()
    const scaled = cloneWorkingSetToScale(captured, 50, { newId })
    expect(scaled.railGroups.flat()).toHaveLength(50)
    expect(scaled.railGroups.every((group) => group.length > 0)).toBe(true)
    expect(scaled.railGroups).toHaveLength(captured.railGroups.length)
    // Saving still never encodes "wake everything" for a later open.
    expect(scaled.revivalOrder).toEqual([])
  })

  it('applies as N dormant rows that the mount authority will not mount', () => {
    for (const rows of SCALES) {
      const scaled = cloneWorkingSetToScale(source(), rows, { newId })
      const point = measureClonedFootprint(scaled, emptyWorkspace(), newId)
      expect({ rows, mount: point.wouldMount, dormant: point.dormantRows }).toEqual({
        rows,
        mount: 0,
        dormant: rows
      })
    }
    expect(spawn).not.toHaveBeenCalled()
  })
})
