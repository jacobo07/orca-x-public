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
  it('makes an unbound row dormant with the verdict it was shown, even though it remembers a ptyId', () => {
    const tabs = { 'wt-1': [tab('a')] }
    const { tabsByWorktree, outcomes } = applyLayoutRestore(tabs, {}, 'wt-1', [
      { tabId: 'a', resumeContinuity: 'unconfirmed' }
    ])
    expect(outcomes).toEqual([{ tabId: 'a', outcome: 'marked' }])
    expect(tabsByWorktree['wt-1']![0]!.dormancy).toEqual({
      reason: 'layout-restore',
      resumeContinuity: 'unconfirmed'
    })
  })

  it('leaves a row with a PTY bound in this window running, judged at apply time', () => {
    const tabs = { 'wt-1': [tab('a'), tab('b')] }
    const { tabsByWorktree, outcomes } = applyLayoutRestore(tabs, { a: ['pty-live'] }, 'wt-1', [
      { tabId: 'a', resumeContinuity: 'none' },
      { tabId: 'b', resumeContinuity: 'none' }
    ])
    expect(outcomes).toEqual([
      { tabId: 'a', outcome: 'bound' },
      { tabId: 'b', outcome: 'marked' }
    ])
    expect(tabsByWorktree['wt-1']![0]!.dormancy).toBeUndefined()
    expect(tabsByWorktree['wt-1']![1]!.dormancy?.reason).toBe('layout-restore')
  })

  it('keeps an existing marker instead of overwriting its reason or verdict', () => {
    const slept = tab('a', { dormancy: { reason: 'workspace-sleep', resumeContinuity: 'exact' } })
    const tabs = { 'wt-1': [slept] }
    const result = applyLayoutRestore(tabs, {}, 'wt-1', [{ tabId: 'a', resumeContinuity: 'none' }])
    expect(result.outcomes).toEqual([{ tabId: 'a', outcome: 'already-dormant' }])
    expect(result.tabsByWorktree).toBe(tabs)
  })

  it('touches only the named workspace and reports a row it does not hold', () => {
    const other = [tab('x')]
    const tabs = { 'wt-1': [tab('a')], 'wt-2': other }
    const result = applyLayoutRestore(tabs, {}, 'wt-1', [
      { tabId: 'x', resumeContinuity: 'none' },
      { tabId: 'a', resumeContinuity: 'none' }
    ])
    expect(result.outcomes).toEqual([
      { tabId: 'x', outcome: 'not-found' },
      { tabId: 'a', outcome: 'marked' }
    ])
    expect(result.tabsByWorktree['wt-2']).toBe(other)
    expect(result.tabsByWorktree['wt-2']![0]!.dormancy).toBeUndefined()
  })

  it('returns the same state object when nothing changed', () => {
    const tabs = { 'wt-1': [tab('a')] }
    expect(applyLayoutRestore(tabs, {}, 'wt-1', []).tabsByWorktree).toBe(tabs)
  })
})
