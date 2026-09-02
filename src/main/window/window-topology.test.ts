/**
 * The window set has to survive a restart without one window inheriting another's project.
 *
 * The cases worth keeping honest are the degenerate ones. An empty capture is what a quit looks
 * like, so publishing it is how a clean shutdown erases the topology it was supposed to save. An
 * unreadable file is not an empty one, and treating it as empty turns a transient read failure into
 * a permanent loss the moment the next write publishes it back. And two entries naming one worktree
 * is not a topology at all — the live registry refuses that binding, so a restore that honoured both
 * would put the same project in two windows, which is the state this whole feature exists to prevent.
 */
import { describe, expect, it } from 'vitest'
import {
  captureWindowTopology,
  normalizeWindowTopology,
  planWindowTopologyRestore,
  shouldPublishWindowTopology
} from './window-topology'

const BOUNDS = { x: 100, y: 120, width: 1200, height: 800 }
const OTHER_BOUNDS = { x: 300, y: 200, width: 1000, height: 700 }

function live(overrides: Partial<Parameters<typeof captureWindowTopology>[0][number]> = {}) {
  return {
    windowId: 'window-1',
    sequence: 1,
    binding: { repoId: 'repo-1', worktreeId: 'repo-1::/tmp/a' },
    bounds: BOUNDS,
    maximized: false,
    ...overrides
  }
}

describe('captureWindowTopology', () => {
  it('records every live window in mint order, bound or not', () => {
    const captured = captureWindowTopology([
      live({ windowId: 'window-2', sequence: 2, binding: null, bounds: OTHER_BOUNDS }),
      live()
    ])

    expect(captured.map((entry) => entry.windowId)).toEqual(['window-1', 'window-2'])
    expect(captured[0].binding).toEqual({ repoId: 'repo-1', worktreeId: 'repo-1::/tmp/a' })
    // An unbound window is a real window showing the launcher, not an absent one.
    expect(captured[1].binding).toBeNull()
    expect(captured[1].bounds).toEqual(OTHER_BOUNDS)
  })
})

describe('shouldPublishWindowTopology', () => {
  it('refuses to publish an empty topology', () => {
    // Every window closing is what a quit looks like. Publishing that erases the set we restore from.
    expect(shouldPublishWindowTopology([], { isQuitting: false })).toBe(false)
  })

  it('refuses to publish while quitting', () => {
    expect(shouldPublishWindowTopology([captureWindowTopology([live()])[0]], { isQuitting: true })).toBe(
      false
    )
  })

  it('publishes a non-empty topology outside a quit', () => {
    expect(
      shouldPublishWindowTopology(captureWindowTopology([live()]), { isQuitting: false })
    ).toBe(true)
  })
})

describe('normalizeWindowTopology', () => {
  it('reads back what it captured', () => {
    const captured = captureWindowTopology([live(), live({ windowId: 'window-2', sequence: 2 })])

    expect(normalizeWindowTopology(JSON.parse(JSON.stringify(captured)))).toEqual(captured)
  })

  it('reports absent state as absent, not as an empty topology', () => {
    expect(normalizeWindowTopology(undefined)).toBeNull()
    expect(normalizeWindowTopology(null)).toBeNull()
  })

  it('reports an unreadable value as absent rather than as no windows', () => {
    // Returning [] here is the shape that turns a bad read into a published erasure.
    expect(normalizeWindowTopology('{')).toBeNull()
    expect(normalizeWindowTopology({ windows: 3 })).toBeNull()
    expect(normalizeWindowTopology([{ nothing: 'usable' }])).toBeNull()
  })

  it('keeps the usable entries when only some are malformed', () => {
    const good = captureWindowTopology([live()])[0]

    const normalized = normalizeWindowTopology([{ windowId: 42 }, good])

    expect(normalized).toEqual([good])
  })

  it('accepts a recorded empty topology as genuinely empty', () => {
    expect(normalizeWindowTopology([])).toEqual([])
  })
})

describe('planWindowTopologyRestore', () => {
  const first = captureWindowTopology([live()])[0]
  const second = captureWindowTopology([
    live({ windowId: 'window-2', sequence: 2, binding: { repoId: 'repo-1', worktreeId: 'repo-1::/tmp/b' } })
  ])[0]

  it('restores one window per entry, in mint order', () => {
    const plan = planWindowTopologyRestore([second, first], { worktreeExists: () => true })

    expect(plan.map((entry) => entry.windowId)).toEqual(['window-1', 'window-2'])
  })

  it('gives a worktree claimed twice to the earliest window only', () => {
    const duplicate = { ...second, binding: first.binding }

    const plan = planWindowTopologyRestore([first, duplicate], { worktreeExists: () => true })

    expect(plan[0].binding).toEqual(first.binding)
    // Not dropped: the window is still real, it just opens on the launcher instead of stealing.
    expect(plan[1].windowId).toBe('window-2')
    expect(plan[1].binding).toBeNull()
  })

  it('unbinds a window whose worktree is gone rather than dropping the window', () => {
    const plan = planWindowTopologyRestore([first], { worktreeExists: () => false })

    expect(plan).toHaveLength(1)
    expect(plan[0].binding).toBeNull()
    expect(plan[0].bounds).toEqual(BOUNDS)
  })

  it('plans nothing from an empty topology, leaving the caller its default single window', () => {
    expect(planWindowTopologyRestore([], { worktreeExists: () => true })).toEqual([])
  })
})
