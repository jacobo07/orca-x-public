import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  greetingWindowCount,
  tabMonogram,
  workspaceAgentCount,
  workspaceBranch
} from './resume-center-workspace-facts'
import { describePaneCount, describeWindowsWith } from './resume-center-presentation'

function worktree(id: string, branch: string | undefined): Worktree {
  return { id, branch } as unknown as Worktree
}

describe('workspaceBranch', () => {
  const byRepo = {
    r1: [worktree('r1::/a', 'refs/heads/main'), worktree('r1::/b', '')],
    r2: [worktree('r2::/c', undefined)]
  }

  it('reads the branch of the worktree the key names, by either key form', () => {
    expect(workspaceBranch(byRepo, 'r1::/a')).toBe('main')
    expect(workspaceBranch(byRepo, 'worktree:r1::/a')).toBe('main')
  })

  it('claims no branch for folders, unknown worktrees, detached heads and folder rows', () => {
    expect(workspaceBranch(byRepo, 'folder:/x')).toBeNull()
    expect(workspaceBranch(byRepo, 'r9::/nowhere')).toBeNull()
    expect(workspaceBranch(byRepo, 'r1::/b')).toBeNull()
    expect(workspaceBranch(byRepo, 'r2::/c')).toBeNull()
  })
})

describe('workspaceAgentCount', () => {
  it('counts tabs that recorded an agent, not shells', () => {
    const tabs = [{ agent: 'claude' }, { agent: null }, { agent: 'codex' }] as never
    expect(workspaceAgentCount({ tabs })).toBe(2)
  })
})

describe('tabMonogram', () => {
  it('takes the first visible character, upper-cased, and never renders empty', () => {
    expect(tabMonogram({ title: '  hermes' })).toBe('H')
    expect(tabMonogram({ title: 'ñandú' })).toBe('Ñ')
    expect(tabMonogram({ title: '   ' })).toBe('?')
  })
})

describe('count words', () => {
  it('says one pane and one window in the singular, every other count in the plural', () => {
    expect(describePaneCount(1)).toBe('1 pane')
    expect(describePaneCount(0)).toBe('0 panes')
    expect(describePaneCount(3)).toBe('3 panes')
    expect(describeWindowsWith(1)).toBe('window with')
    expect(describeWindowsWith(2)).toBe('windows with')
  })
})

describe('greetingWindowCount', () => {
  it('claims windows only when the desk recorded them', () => {
    expect(greetingWindowCount({ windowsRecorded: true, windowCount: 3 })).toBe(3)
    expect(greetingWindowCount({ windowsRecorded: true, windowCount: 0 })).toBe(0)
    expect(greetingWindowCount({ windowsRecorded: false, windowCount: 0 })).toBeNull()
  })
})
