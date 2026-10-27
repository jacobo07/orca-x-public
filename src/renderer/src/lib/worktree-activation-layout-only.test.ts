import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const wakeMocks = vi.hoisted(() => ({
  resumeSleepingAgentSessionsForWorktree: vi.fn(() => 0),
  ensureWebRuntimeWorktreeTerminalAfterWake: vi.fn()
}))
vi.mock('@/lib/resume-sleeping-agent-session', () => ({
  resumeSleepingAgentSessionsForWorktree: wakeMocks.resumeSleepingAgentSessionsForWorktree
}))
vi.mock('@/lib/web-runtime-worktree-terminal-after-wake', () => ({
  ensureWebRuntimeWorktreeTerminalAfterWake: wakeMocks.ensureWebRuntimeWorktreeTerminalAfterWake
}))

import { activateAndRevealWorktree } from './worktree-activation'
import { registerWorktreeActivationReset } from './worktree-activation-test-harness'
import { useAppStore } from '@/store'

registerWorktreeActivationReset()

const worktree = {
  id: 'wt-1',
  repoId: 'repo-1',
  path: '/repo',
  displayName: 'main',
  branch: 'main',
  head: 'abc',
  isBare: false,
  isMainWorktree: true
}

function seedStore(): {
  createTab: ReturnType<typeof vi.fn>
  setActiveWorktree: ReturnType<typeof vi.fn>
} {
  const createTab = vi.fn(() => ({ id: 'tab-new' }))
  const setActiveWorktree = vi.fn()
  useAppStore.setState({
    activeRepoId: null,
    activeWorktreeId: null,
    activeView: 'terminal',
    filterRepoIds: [],
    isNavigatingHistory: false,
    repos: [{ id: 'repo-1', connectionId: null }],
    worktreesByRepo: { 'repo-1': [worktree] },
    getKnownWorktreeById: (id: string) => (id === 'wt-1' ? (worktree as never) : null),
    setActiveRepo: vi.fn(),
    setActiveView: vi.fn(),
    setActiveWorktree,
    markWorktreeVisited: vi.fn(),
    recordWorktreeVisit: vi.fn(),
    // An empty workspace is the case where activation would seed a terminal of its own.
    reconcileWorktreeTabModel: vi.fn(() => ({ renderableTabCount: 0 })),
    createTab,
    setActiveTab: vi.fn(),
    setTabCustomTitle: vi.fn(),
    queueTabStartupCommand: vi.fn(),
    queueTabInitialCwd: vi.fn(),
    revealWorktreeInSidebar: vi.fn()
  } as never)
  return { createTab, setActiveWorktree }
}

describe('activateAndRevealWorktree layout-only', () => {
  beforeEach(() => {
    wakeMocks.resumeSleepingAgentSessionsForWorktree.mockClear()
    wakeMocks.ensureWebRuntimeWorktreeTerminalAfterWake.mockClear()
  })
  afterEach(() => {
    useAppStore.setState({ activeWorktreeId: null, activeRepoId: null })
  })

  it('activates the workspace and starts nothing when wake is false', () => {
    const { createTab, setActiveWorktree } = seedStore()

    const result = activateAndRevealWorktree('wt-1', { wake: false })

    expect(result).toEqual({ primaryTabId: null })
    expect(setActiveWorktree).toHaveBeenCalledWith('wt-1', undefined)
    expect(wakeMocks.resumeSleepingAgentSessionsForWorktree).not.toHaveBeenCalled()
    expect(createTab).not.toHaveBeenCalled()
    expect(wakeMocks.ensureWebRuntimeWorktreeTerminalAfterWake).not.toHaveBeenCalled()
  })

  it('control: an ordinary activation still wakes sleeping agents and seeds a terminal', () => {
    const { createTab } = seedStore()

    activateAndRevealWorktree('wt-1')

    expect(wakeMocks.resumeSleepingAgentSessionsForWorktree).toHaveBeenCalledWith('wt-1')
    expect(createTab).toHaveBeenCalled()
    expect(wakeMocks.ensureWebRuntimeWorktreeTerminalAfterWake).toHaveBeenCalledWith('wt-1')
  })
})
