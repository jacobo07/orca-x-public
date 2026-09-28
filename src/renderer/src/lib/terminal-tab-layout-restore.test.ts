import { describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { applyLayoutRestore } from './terminal-tab-layout-restore'

function tab(id: string, extra: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id,
    ptyId: `pty-${id}`,
    worktreeId: 'wt-1',
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...extra
  } as TerminalTab
}

describe('applyLayoutRestore', () => {
  it('marks a row whose remembered ids the host does not list, even though hydration bound them', () => {
    // Why this case: after a relaunch the store holds the saved ids in ptyIdsByTabId as well as
    // tab.ptyId, so a store-only "bound" check leaves exactly the row that must not mount.
    const tabs = { 'wt-1': [tab('a')] }
    const { tabsByWorktree, outcomes } = applyLayoutRestore(
      tabs,
      { a: ['pty-a'] },
      'wt-1',
      [{ tabId: 'a', resumeContinuity: 'unconfirmed' }],
      new Set(['some-other-session'])
    )
    expect(outcomes).toEqual([{ tabId: 'a', outcome: 'marked' }])
    expect(tabsByWorktree['wt-1']![0]!.dormancy).toEqual({
      reason: 'layout-restore',
      resumeContinuity: 'unconfirmed'
    })
  })

  it('leaves a row the host lists as live running, by its tab id or any bound pane id', () => {
    const tabs = { 'wt-1': [tab('a'), tab('b', { ptyId: null }), tab('c')] }
    const { tabsByWorktree, outcomes } = applyLayoutRestore(
      tabs,
      { b: ['pane-b2'] },
      'wt-1',
      ['a', 'b', 'c'].map((tabId) => ({ tabId, resumeContinuity: 'none' as const })),
      new Set(['pty-a', 'pane-b2'])
    )
    expect(outcomes.map((o) => o.outcome)).toEqual(['running', 'running', 'marked'])
    expect(tabsByWorktree['wt-1']!.map((t) => t.dormancy?.reason ?? null)).toEqual([
      null,
      null,
      'layout-restore'
    ])
  })

  it('trusts the caller when the host could not be asked', () => {
    const tabs = { 'wt-1': [tab('a')] }
    const { outcomes } = applyLayoutRestore(
      tabs,
      { a: ['pty-a'] },
      'wt-1',
      [{ tabId: 'a', resumeContinuity: 'none' }],
      null
    )
    expect(outcomes).toEqual([{ tabId: 'a', outcome: 'marked' }])
  })

  it('keeps an existing marker instead of overwriting its reason or verdict', () => {
    const slept = tab('a', { dormancy: { reason: 'workspace-sleep', resumeContinuity: 'exact' } })
    const tabs = { 'wt-1': [slept] }
    const result = applyLayoutRestore(
      tabs,
      {},
      'wt-1',
      [{ tabId: 'a', resumeContinuity: 'none' }],
      new Set()
    )
    expect(result.outcomes).toEqual([{ tabId: 'a', outcome: 'already-dormant' }])
    expect(result.tabsByWorktree).toBe(tabs)
  })

  it('touches only the named workspace and reports a row it does not hold', () => {
    const other = [tab('x')]
    const tabs = { 'wt-1': [tab('a')], 'wt-2': other }
    const result = applyLayoutRestore(
      tabs,
      {},
      'wt-1',
      [
        { tabId: 'x', resumeContinuity: 'none' },
        { tabId: 'a', resumeContinuity: 'none' }
      ],
      new Set()
    )
    expect(result.outcomes).toEqual([
      { tabId: 'x', outcome: 'not-found' },
      { tabId: 'a', outcome: 'marked' }
    ])
    expect(result.tabsByWorktree['wt-2']).toBe(other)
  })

  it('returns the same state object when nothing changed', () => {
    const tabs = { 'wt-1': [tab('a')] }
    expect(applyLayoutRestore(tabs, {}, 'wt-1', [], new Set()).tabsByWorktree).toBe(tabs)
  })
})
