import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import { getPinnedTerminalTabIds } from './agent-hibernation-planner-snapshot'

function state(input: {
  terminal?: { id: string; isPinned?: boolean }[]
  unified?: { id: string; entityId: string; contentType: string; isPinned?: boolean }[]
}): AppState {
  return {
    tabsByWorktree: { wt: input.terminal ?? [] },
    unifiedTabsByWorktree: { wt: input.unified ?? [] }
  } as unknown as AppState
}

describe('pinned terminal tabs read by the sleep planner', () => {
  it('reads nothing when no tab is pinned', () => {
    expect(
      getPinnedTerminalTabIds(
        state({
          terminal: [{ id: 'tab-1' }],
          unified: [{ id: 'tab-1', entityId: 'tab-1', contentType: 'terminal' }]
        })
      )
    ).toEqual([])
  })

  it('counts the terminal tab copy of the pin', () => {
    expect(getPinnedTerminalTabIds(state({ terminal: [{ id: 'tab-1', isPinned: true }] }))).toEqual(
      ['tab-1']
    )
  })

  // Why: the tab bar pins the unified tab; a mirror that missed must not un-pin the terminal.
  it('counts the unified pin by the terminal it names, not by its own id', () => {
    expect(
      getPinnedTerminalTabIds(
        state({
          terminal: [{ id: 'term-9', isPinned: false }],
          unified: [
            { id: 'unified-9', entityId: 'term-9', contentType: 'terminal', isPinned: true }
          ]
        })
      )
    ).toEqual(['term-9'])
  })

  it('ignores pins on editor and browser tabs', () => {
    expect(
      getPinnedTerminalTabIds(
        state({
          unified: [{ id: 'ed-1', entityId: 'file.ts', contentType: 'editor', isPinned: true }]
        })
      )
    ).toEqual([])
  })
})
