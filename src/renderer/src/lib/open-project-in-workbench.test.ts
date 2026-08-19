import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openProjectInWorkbench, pickProjectWorkspaceToOpen } from './open-project-in-workbench'

const focusTerminalTabSurface = vi.fn()
vi.mock('@/lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: (...args: unknown[]) => focusTerminalTabSurface(...args)
}))

const state = {
  worktreesByRepo: {} as Record<string, { id: string }[]>,
  lastVisitedAtByWorktreeId: {} as Record<string, number>,
  tabsByWorktree: {} as Record<string, { id: string }[]>,
  activeGroupIdByWorktree: {} as Record<string, string | null>,
  activeTabIdByWorktree: {} as Record<string, string | null>,
  setActiveWorktree: vi.fn<(id: string) => boolean>(),
  setActiveView: vi.fn(),
  setActiveTabType: vi.fn(),
  openNewTerminalTabInActiveWorkspace: vi.fn<(groupId?: string) => Promise<void>>()
}

vi.mock('@/store', () => ({
  useAppStore: { getState: () => state }
}))

beforeEach(() => {
  vi.clearAllMocks()
  state.worktreesByRepo = { orca: [{ id: 'orca-main' }, { id: 'orca-feature' }] }
  state.lastVisitedAtByWorktreeId = {}
  state.tabsByWorktree = {}
  state.activeGroupIdByWorktree = {}
  state.activeTabIdByWorktree = {}
  state.setActiveWorktree.mockReturnValue(true)
  state.openNewTerminalTabInActiveWorkspace.mockImplementation(async () => {
    state.tabsByWorktree['orca-main'] = [{ id: 'terminal-new' }]
    state.activeTabIdByWorktree['orca-main'] = 'terminal-new'
  })
})

describe('pickProjectWorkspaceToOpen', () => {
  it('returns null when the project has no workspace yet', () => {
    expect(pickProjectWorkspaceToOpen([], {})).toBeNull()
    expect(pickProjectWorkspaceToOpen(undefined, {})).toBeNull()
  })

  it('falls back to the first workspace when none was ever visited', () => {
    expect(pickProjectWorkspaceToOpen([{ id: 'a' }, { id: 'b' }], {})).toBe('a')
  })

  it('reopens the most recently visited workspace', () => {
    // Reopening a project should land on the branch that was being worked on, not on whichever
    // workspace happens to sort first.
    expect(pickProjectWorkspaceToOpen([{ id: 'a' }, { id: 'b' }], { a: 10, b: 20 })).toBe('b')
    expect(pickProjectWorkspaceToOpen([{ id: 'a' }, { id: 'b' }], { a: 30, b: 20 })).toBe('a')
  })

  it('ignores visit records for workspaces this project does not have', () => {
    // The visit map is global, so a stale entry for a deleted or unrelated workspace must not
    // decide which workspace of THIS project opens.
    expect(pickProjectWorkspaceToOpen([{ id: 'a' }], { somewhere_else: 99 })).toBe('a')
  })

  it('ignores a non-numeric visit record rather than ranking it', () => {
    const corrupt = { a: Number.NaN, b: 5 } as Record<string, number>
    expect(pickProjectWorkspaceToOpen([{ id: 'a' }, { id: 'b' }], corrupt)).toBe('b')
  })
})

describe('openProjectInWorkbench', () => {
  it('activates the workspace and starts a terminal when it has none', async () => {
    const outcome = await openProjectInWorkbench('orca')

    expect(outcome).toBe('opened-with-terminal')
    expect(state.setActiveWorktree).toHaveBeenCalledWith('orca-main')
    expect(state.setActiveView).toHaveBeenCalledWith('terminal')
    expect(state.openNewTerminalTabInActiveWorkspace).toHaveBeenCalledOnce()
    expect(focusTerminalTabSurface).toHaveBeenCalledWith('terminal-new')
  })

  it('does not add a terminal to a workspace that already has one', async () => {
    // Otherwise every reopen leaves one more shell behind, and a project left with three terminals
    // comes back with four.
    state.tabsByWorktree = { 'orca-main': [{ id: 'terminal-existing' }] }
    state.activeTabIdByWorktree = { 'orca-main': 'terminal-existing' }

    const outcome = await openProjectInWorkbench('orca')

    expect(outcome).toBe('opened')
    expect(state.openNewTerminalTabInActiveWorkspace).not.toHaveBeenCalled()
    // A workspace showing an editor keeps rendering it, so its terminals would stay behind the file.
    expect(state.setActiveTabType).toHaveBeenCalledWith('terminal')
    expect(focusTerminalTabSurface).toHaveBeenCalledWith('terminal-existing')
  })

  it('reports a project with no workspace instead of navigating', async () => {
    state.worktreesByRepo = { orca: [] }

    const outcome = await openProjectInWorkbench('orca')

    expect(outcome).toBe('no-workspace')
    expect(state.setActiveWorktree).not.toHaveBeenCalled()
    expect(state.setActiveView).not.toHaveBeenCalled()
  })

  it('stays put when activation is refused', async () => {
    // Distinct from success: navigating past a refusal shows an empty workbench, which reads as a
    // broken open rather than as a workspace that could not be entered.
    state.setActiveWorktree.mockReturnValue(false)

    const outcome = await openProjectInWorkbench('orca')

    expect(outcome).toBe('activation-refused')
    expect(state.setActiveView).not.toHaveBeenCalled()
    expect(state.openNewTerminalTabInActiveWorkspace).not.toHaveBeenCalled()
  })

  it('opens the workspace the user last worked in', async () => {
    state.lastVisitedAtByWorktreeId = { 'orca-main': 1, 'orca-feature': 2 }
    state.tabsByWorktree = { 'orca-feature': [{ id: 'terminal-feature' }] }
    state.activeTabIdByWorktree = { 'orca-feature': 'terminal-feature' }

    const outcome = await openProjectInWorkbench('orca')

    expect(outcome).toBe('opened')
    expect(state.setActiveWorktree).toHaveBeenCalledWith('orca-feature')
  })

  it('passes the workspace group along, and omits it when there is none', async () => {
    await openProjectInWorkbench('orca')
    expect(state.openNewTerminalTabInActiveWorkspace).toHaveBeenCalledWith(undefined)

    vi.clearAllMocks()
    state.setActiveWorktree.mockReturnValue(true)
    state.tabsByWorktree = {}
    state.activeGroupIdByWorktree = { 'orca-main': 'group-1' }

    await openProjectInWorkbench('orca')
    expect(state.openNewTerminalTabInActiveWorkspace).toHaveBeenCalledWith('group-1')
  })
})
