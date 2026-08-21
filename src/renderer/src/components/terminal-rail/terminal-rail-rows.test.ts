import { describe, expect, it } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import {
  buildTerminalRailRows,
  collectOrderedLeafIds,
  findActiveTerminalRailRow
} from './terminal-rail-rows'

function layout(root: TerminalLayoutSnapshot['root']): TerminalLayoutSnapshot {
  return { root, activeLeafId: null, expandedLeafId: null }
}

const SPLIT_OF_THREE = layout({
  type: 'split',
  direction: 'vertical',
  first: { type: 'leaf', leafId: 'a' },
  second: {
    type: 'split',
    direction: 'horizontal',
    first: { type: 'leaf', leafId: 'b' },
    second: { type: 'leaf', leafId: 'c' }
  }
})

describe('collectOrderedLeafIds', () => {
  it('reads leaves in layout order', () => {
    expect(collectOrderedLeafIds(SPLIT_OF_THREE.root)).toEqual(['a', 'b', 'c'])
  })

  it('treats an absent layout as no panes rather than as one', () => {
    // A tab whose layout has not hydrated yet must not claim a pane it cannot address.
    expect(collectOrderedLeafIds(null)).toEqual([])
  })
})

describe('buildTerminalRailRows', () => {
  it('gives a single-pane tab no child row', () => {
    const rows = buildTerminalRailRows({
      tabIds: ['t1'],
      layoutsByTabId: { t1: layout({ type: 'leaf', leafId: 'a' }) }
    })

    expect(rows).toEqual([{ kind: 'tab', tabId: 't1', leafId: 'a', paneCount: 1 }])
  })

  it('lists a split tab as a tab row followed by its panes', () => {
    const rows = buildTerminalRailRows({
      tabIds: ['t1'],
      layoutsByTabId: { t1: SPLIT_OF_THREE }
    })

    expect(rows.map((row) => `${row.kind}:${row.kind === 'pane' ? row.leafId : row.tabId}`)).toEqual(
      ['tab:t1', 'pane:a', 'pane:b', 'pane:c']
    )
    expect(rows[0]).toMatchObject({ leafId: null, paneCount: 3 })
  })

  it('numbers panes by position so an unnamed pane is still addressable', () => {
    const rows = buildTerminalRailRows({ tabIds: ['t1'], layoutsByTabId: { t1: SPLIT_OF_THREE } })

    expect(rows.filter((row) => row.kind === 'pane').map((row) => row.position)).toEqual([1, 2, 3])
  })

  it('keeps tabs in the order given', () => {
    const rows = buildTerminalRailRows({
      tabIds: ['t2', 't1'],
      layoutsByTabId: {
        t1: layout({ type: 'leaf', leafId: 'a' }),
        t2: layout({ type: 'leaf', leafId: 'b' })
      }
    })

    expect(rows.map((row) => row.tabId)).toEqual(['t2', 't1'])
  })
})

describe('findActiveTerminalRailRow', () => {
  const rows = buildTerminalRailRows({ tabIds: ['t1'], layoutsByTabId: { t1: SPLIT_OF_THREE } })

  it('selects the pane row when the tab is split', () => {
    expect(findActiveTerminalRailRow(rows, 't1', 'b')).toMatchObject({ kind: 'pane', leafId: 'b' })
  })

  it('falls back to the tab row when the active leaf has no row of its own', () => {
    // A single-pane tab has no pane row, and a stale activeLeafId must not leave nothing selected.
    expect(findActiveTerminalRailRow(rows, 't1', 'gone')).toMatchObject({ kind: 'tab' })
  })

  it('selects nothing when no terminal tab is active', () => {
    expect(findActiveTerminalRailRow(rows, null, 'b')).toBeNull()
  })
})
