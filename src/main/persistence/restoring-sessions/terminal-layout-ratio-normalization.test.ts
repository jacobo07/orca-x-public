import { describe, expect, test } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'
import { normalizeTerminalLayoutSnapshotForPersistence } from './terminal-layout-normalization'

const FIRST_LEAF = '11111111-1111-4111-8111-111111111111'
const SECOND_LEAF = '22222222-2222-4222-8222-222222222222'

// Why real UUIDs: a legacy leaf id would trip the id-rewrite repair and mask whether the ratio
// itself was normalized.
function splitSnapshot(ratio: unknown): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: FIRST_LEAF },
      second: { type: 'leaf', leafId: SECOND_LEAF },
      ...(ratio === undefined ? {} : { ratio: ratio as number })
    },
    activeLeafId: FIRST_LEAF,
    expandedLeafId: null
  }
}

function rootRatioOf(snapshot: TerminalLayoutSnapshot): number | undefined {
  const root = snapshot.root
  return root && root.type === 'split' ? root.ratio : undefined
}

describe('persisted split ratio normalization', () => {
  // Why these reach disk at all: the persisted value can be hand-edited, written by a host on
  // another version, or survive from a schema that never bounded it — workspace-session-schema
  // types it as a plain optional number. A non-finite or out-of-range flex basis collapses a pane
  // to nothing, which reads as the terminal having vanished rather than as a bad number.
  test.each([
    ['not a number', '0.3'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['negative', -1],
    ['zero', 0],
    ['one', 1],
    ['far above one', 42]
  ])('drops an unusable ratio (%s) back to the documented default', (_label, ratio) => {
    // Arrange
    const snapshot = splitSnapshot(ratio)

    // Act
    const result = normalizeTerminalLayoutSnapshotForPersistence(snapshot)

    // Assert
    expect(rootRatioOf(result.snapshot)).toBeUndefined()
    expect(result.changed).toBe(true)
  })

  // Why not clamp into a comfortable band: a 50px pane on a wide monitor is a legitimately tiny
  // ratio, so repairing "unusual" would move a layout the user actually dragged. Only the
  // genuinely unusable is repaired.
  test.each([
    ['a very small but usable ratio', 0.02],
    ['a very large but usable ratio', 0.98],
    ['an ordinary ratio', 0.75]
  ])('preserves %s untouched', (_label, ratio) => {
    // Arrange
    const snapshot = splitSnapshot(ratio)

    // Act
    const result = normalizeTerminalLayoutSnapshotForPersistence(snapshot)

    // Assert
    expect(rootRatioOf(result.snapshot)).toBe(ratio)
  })

  test('reports no change when every ratio is already usable', () => {
    // Arrange
    const snapshot = splitSnapshot(0.6)

    // Act
    const result = normalizeTerminalLayoutSnapshotForPersistence(snapshot)

    // Assert
    expect(result.changed).toBe(false)
    expect(result.snapshot).toBe(snapshot)
  })

  test('repairs a ratio nested under a healthy outer split', () => {
    // Arrange
    const thirdLeaf = '33333333-3333-4333-8333-333333333333'
    const snapshot: TerminalLayoutSnapshot = {
      root: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.4,
        first: { type: 'leaf', leafId: FIRST_LEAF },
        second: {
          type: 'split',
          direction: 'horizontal',
          ratio: Number.NaN,
          first: { type: 'leaf', leafId: SECOND_LEAF },
          second: { type: 'leaf', leafId: thirdLeaf }
        }
      },
      activeLeafId: FIRST_LEAF,
      expandedLeafId: null
    }

    // Act
    const result = normalizeTerminalLayoutSnapshotForPersistence(snapshot)

    // Assert
    const root = result.snapshot.root
    expect(root?.type).toBe('split')
    if (root?.type !== 'split' || root.second.type !== 'split') {
      throw new Error('expected the repaired root to keep its nested split')
    }
    expect(root.ratio).toBe(0.4)
    expect(root.second.ratio).toBeUndefined()
    expect(result.changed).toBe(true)
  })
})
