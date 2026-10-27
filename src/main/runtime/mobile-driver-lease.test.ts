/**
 * The phone's control lease: a phone that only watches loses the terminal to the next desktop
 * keystroke once the lease has expired. Spec: .planning/phases/12-remote-control-lease-and-viewport/12-LEASE-SPEC.md
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitUsernameModule from '../git/git-username'
import { MOBILE_DRIVER_LEASE_MS } from '../../shared/mobile-driver-lease'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([]),
  listWorktreesStrict: vi.fn().mockResolvedValue([])
}))
vi.mock('../hooks', () => ({
  getEffectiveHooks: vi.fn().mockReturnValue(null),
  runHook: vi.fn().mockResolvedValue({ success: true, output: '' })
}))
vi.mock('../worktree-runner-script', () => ({ createSetupRunnerScript: vi.fn() }))
vi.mock('../ipc/worktree-logic', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, computeWorktreePath: vi.fn(), ensurePathWithinWorkspace: vi.fn() }
})
vi.mock('../ipc/registered-worktree-roots-cache', () => ({
  invalidateAuthorizedRootsCache: vi.fn()
}))
vi.mock('../git/repo', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getDefaultBaseRef: vi.fn().mockReturnValue('origin/main'),
    getBranchConflictKind: vi.fn().mockResolvedValue(null)
  }
})
vi.mock('../git/git-username', async () => {
  const actual = await vi.importActual<typeof GitUsernameModule>('../git/git-username')
  return { ...actual, resolveLocalGitUsername: vi.fn(async () => '') }
})

function createRuntime(): OrcaRuntimeService {
  const repo = {
    id: 'repo-1',
    path: '/tmp/repo',
    displayName: 'repo',
    badgeColor: 'blue',
    addedAt: 1
  }
  const runtime = new OrcaRuntimeService({
    getRepo: () => repo,
    getRepos: () => [repo],
    addRepo: () => {},
    updateRepo: () => undefined as never,
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    getGitHubCache: () => ({ pr: {}, issue: {} }),
    setWorktreeMeta: () => undefined as never,
    removeWorktreeMeta: () => {},
    getRetiredWorktreeNameRegistry: () => ({ exhaustedTiers: 0, names: [] }),
    addRetiredWorktreeName: () => {},
    mergeRetiredWorktreeNames: () => false,
    getSettings: () => ({
      workspaceDir: '/tmp/workspaces',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: 'none',
      branchPrefixCustom: '',
      mobileAutoRestoreFitMs: 5_000
    })
  })
  const sizes = new Map([['pty-1', { cols: 150, rows: 40 }]])
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    resize: (ptyId, cols, rows) => {
      sizes.set(ptyId, { cols, rows })
      return true
    },
    getSize: (ptyId) => sizes.get(ptyId) ?? null
  })
  return runtime
}

const later = (ms: number): void => {
  vi.setSystemTime(Date.now() + ms)
}

describe('mobile driver lease', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('keeps the terminal with a phone that acted within the lease', async () => {
    const runtime = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    later(MOBILE_DRIVER_LEASE_MS - 10_000)

    const answer = await runtime.reclaimTerminalForDesktopIfPhoneIdle('pty-1')

    expect(answer.reclaimed).toBe(false)
    expect(answer.retryAfterMs).toBe(10_000)
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-A' })
  })

  it('hands the terminal to the desktop once the phone has only watched for the lease', async () => {
    const runtime = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    later(MOBILE_DRIVER_LEASE_MS)

    await expect(runtime.reclaimTerminalForDesktopIfPhoneIdle('pty-1')).resolves.toEqual({
      reclaimed: true
    })
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'desktop' })
  })

  it('lets a later phone action take the terminal again', async () => {
    const runtime = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    later(MOBILE_DRIVER_LEASE_MS)
    await runtime.reclaimTerminalForDesktopIfPhoneIdle('pty-1')

    await runtime.mobileTookFloor('pty-1', 'phone-A')

    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-A' })
  })

  it('renews the lease on a phone action', async () => {
    const runtime = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    later(MOBILE_DRIVER_LEASE_MS - 1_000)
    await runtime.mobileTookFloor('pty-1', 'phone-A')
    later(MOBILE_DRIVER_LEASE_MS - 1_000)

    expect((await runtime.reclaimTerminalForDesktopIfPhoneIdle('pty-1')).reclaimed).toBe(false)
  })

  it('counts the newest action of any subscribed phone', async () => {
    const runtime = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    later(MOBILE_DRIVER_LEASE_MS)
    await runtime.handleMobileSubscribe('pty-1', 'phone-B', { cols: 40, rows: 18 })
    await runtime.mobileTookFloor('pty-1', 'phone-A')
    later(MOBILE_DRIVER_LEASE_MS)
    await runtime.updateMobileViewport('pty-1', 'phone-B', { cols: 41, rows: 18 })

    expect((await runtime.reclaimTerminalForDesktopIfPhoneIdle('pty-1')).reclaimed).toBe(false)
  })

  it('keeps the lease while a phone write is in flight', async () => {
    const runtime = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    later(MOBILE_DRIVER_LEASE_MS)
    const floor = runtime.beginMobileInputFloor('pty-1', 'phone-A')
    expect(floor).not.toBeNull()

    expect((await runtime.reclaimTerminalForDesktopIfPhoneIdle('pty-1')).reclaimed).toBe(false)
    floor!.rollback()
  })

  it('leaves a phone driver with no subscribed phone to the explicit Take back', async () => {
    const runtime = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    runtime.handleMobileUnsubscribe('pty-1', 'phone-A')
    later(10 * MOBILE_DRIVER_LEASE_MS)
    const driverBefore = runtime.getDriver('pty-1')

    await expect(runtime.reclaimTerminalForDesktopIfPhoneIdle('pty-1')).resolves.toEqual({
      reclaimed: false
    })
    expect(runtime.getDriver('pty-1')).toEqual(driverBefore)
  })

  it('does nothing for a terminal no phone drives', async () => {
    const runtime = createRuntime()

    await expect(runtime.reclaimTerminalForDesktopIfPhoneIdle('pty-1')).resolves.toEqual({
      reclaimed: false
    })
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'idle' })
  })
})
