import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitStatusResult } from '../../../shared/git-status-types'
import {
  continueSourceStateFromStatus,
  readContinueSourceState
} from './project-working-set-continue-source-state'

const mocks = vi.hoisted(() => ({
  worktreesByRepo: {} as Record<string, { id: string; path: string }[]>,
  getRuntimeGitStatus: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ repos: [], settings: {}, worktreesByRepo: mocks.worktreesByRepo })
  }
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => null }))
vi.mock('@/lib/worktree-runtime-owner', () => ({ getSettingsForWorktreeRuntimeOwner: () => ({}) }))
vi.mock('@/runtime/runtime-git-client', () => ({
  getRuntimeGitStatus: mocks.getRuntimeGitStatus
}))

function status(over: Partial<GitStatusResult>): GitStatusResult {
  return { entries: [], conflictOperation: 'unknown', ...over } as GitStatusResult
}

describe('continueSourceStateFromStatus', () => {
  it('reads an unreadable status as unknown, never as clean', () => {
    expect(continueSourceStateFromStatus(null)).toBe('unknown')
  })

  it('reads any entry, staged, unstaged or untracked, as uncommitted changes', () => {
    const entry = { path: 'a.txt', status: 'untracked', area: 'untracked' }
    expect(continueSourceStateFromStatus(status({ entries: [entry] as never }))).toBe(
      'uncommitted-changes'
    )
  })

  it('reads a capped listing as uncommitted changes even when its entries were cut', () => {
    expect(continueSourceStateFromStatus(status({ didHitLimit: true }))).toBe('uncommitted-changes')
  })

  it('control: a read with no entries and no cap is clean', () => {
    expect(continueSourceStateFromStatus(status({}))).toBe('clean')
  })
})

describe('readContinueSourceState', () => {
  beforeEach(() => {
    mocks.worktreesByRepo = { 'repo-1': [{ id: 'wt-1', path: '/work/orca' }] }
    mocks.getRuntimeGitStatus.mockReset()
  })

  it('is unknown when the workspace is not in the store, without reading git', async () => {
    expect(await readContinueSourceState('wt-missing')).toBe('unknown')
    expect(mocks.getRuntimeGitStatus).not.toHaveBeenCalled()
  })

  it('fails closed to unknown when the status read throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.getRuntimeGitStatus.mockRejectedValue(new Error('ssh down'))
    expect(await readContinueSourceState('wt-1')).toBe('unknown')
  })

  it('control: reads the named workspace and reports clean', async () => {
    mocks.getRuntimeGitStatus.mockResolvedValue(status({}))
    expect(await readContinueSourceState('wt-1')).toBe('clean')
    expect(mocks.getRuntimeGitStatus).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'wt-1', worktreePath: '/work/orca' })
    )
  })
})
