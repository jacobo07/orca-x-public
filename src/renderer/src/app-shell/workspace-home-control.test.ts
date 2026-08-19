import { describe, it, expect, beforeEach } from 'vitest'
import { useAppStore } from '../store'

const WORKTREE = 'repo-a::/a'

const terminalTab = () => ({
  id: 'tab-a',
  ptyId: 'pty-a',
  worktreeId: WORKTREE,
  title: 'Terminal',
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 1
})

// Going Home must be a change of view, not an exit from the work. The titlebar's Home control is
// the only way back from a project, so if it discarded session state it would be a destructive
// button that looks like navigation.
describe('the Workspace home control', () => {
  beforeEach(() => {
    useAppStore.setState({
      activeView: 'terminal',
      activeRepoId: 'repo-a',
      activeWorktreeId: WORKTREE,
      tabsByWorktree: { [WORKTREE]: [terminalTab()] }
    })
  })

  it('leaves the project terminals and active workspace intact', () => {
    // Act
    useAppStore.getState().openWorkspacePage()

    // Assert
    const state = useAppStore.getState()
    expect(state.activeView).toBe('workspace')
    expect(state.tabsByWorktree[WORKTREE]).toHaveLength(1)
    expect(state.activeWorktreeId).toBe(WORKTREE)
    expect(state.activeRepoId).toBe('repo-a')
  })

  it('returns to the same project when the workbench is shown again', () => {
    // Arrange
    useAppStore.getState().openWorkspacePage()

    // Act — the user comes back, without reopening the project.
    useAppStore.getState().setActiveView('terminal')

    // Assert
    const state = useAppStore.getState()
    expect(state.activeWorktreeId).toBe(WORKTREE)
    expect(state.tabsByWorktree[WORKTREE]?.[0]?.ptyId).toBe('pty-a')
  })
})
