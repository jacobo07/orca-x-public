import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { createCompatibleRuntimeStatusResponseIfNeeded } from '../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../runtime/runtime-rpc-client'
import {
  RUNTIME_PTY_LIVENESS_BUDGET_MS,
  resetRuntimePtyLivenessQueueForTests,
  sampleRuntimePtyLiveness
} from './runtime-pty-liveness-sample'
import { fenceRuntimePtyLivenessSample } from './agent-hibernation-planner-snapshot'

const call = vi.fn()
vi.stubGlobal('window', { api: { runtimeEnvironments: { call } } })

type ListArgs = { selector: string; method: string; params: { worktree: string } }

function tab(worktreeId: string) {
  return {
    id: `tab-${worktreeId}`,
    ptyId: null,
    worktreeId,
    title: 'Agent',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

/** Worktrees keyed to the runtime that owns them. */
function installWorktrees(owners: Record<string, string>): void {
  useAppStore.setState({
    activeWorktreeId: null,
    repos: [],
    detectedWorktreesByRepo: {},
    worktreesByRepo: {
      'fixture-repo': Object.entries(owners).map(([id, runtimeOwnerEnvironmentId]) => ({
        id,
        repoId: 'fixture-repo',
        hostId: 'local',
        runtimeOwnerEnvironmentId
      }))
    } as never,
    tabsByWorktree: Object.fromEntries(Object.keys(owners).map((id) => [id, [tab(id)]]))
  })
}

function worktreeOf(args: ListArgs): string {
  return args.params.worktree.replace(/^id:/, '')
}

function listResponse(worktreeId: string, ptyIds: string[]) {
  return {
    id: 'terminal-list',
    ok: true,
    result: {
      terminals: ptyIds.map((ptyId) => ({
        handle: `h-${ptyId}`,
        ptyId,
        worktreeId,
        worktreePath: `/tmp/${worktreeId}`,
        branch: 'b',
        tabId: `pty:${ptyId}`,
        leafId: `pty:${ptyId}`,
        title: '',
        connected: true,
        writable: true,
        lastOutputAt: null,
        preview: ''
      })),
      totalCount: ptyIds.length,
      truncated: false
    },
    _meta: { runtimeId: 'runtime' }
  }
}

/** Routes terminal.list to `onList`; tracks how many are in flight per host. */
function installRuntime(onList: (args: ListArgs) => Promise<unknown>): {
  maxInFlight: Map<string, number>
  started: string[]
} {
  const inFlight = new Map<string, number>()
  const maxInFlight = new Map<string, number>()
  const started: string[] = []
  call.mockImplementation((args: ListArgs) => {
    const compatible = createCompatibleRuntimeStatusResponseIfNeeded(args)
    if (compatible) {
      return Promise.resolve(compatible)
    }
    if (args.method !== 'terminal.list') {
      return Promise.resolve({ id: 'x', ok: true, result: {}, _meta: { runtimeId: 'runtime' } })
    }
    started.push(`${args.selector}/${worktreeOf(args)}`)
    const now = (inFlight.get(args.selector) ?? 0) + 1
    inFlight.set(args.selector, now)
    maxInFlight.set(args.selector, Math.max(now, maxInFlight.get(args.selector) ?? 0))
    return onList(args).finally(() =>
      inFlight.set(args.selector, (inFlight.get(args.selector) ?? 1) - 1)
    )
  })
  return { maxInFlight, started }
}

function later<T>(value: T, ms = 5): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

afterEach(() => {
  resetRuntimePtyLivenessQueueForTests()
  call.mockReset()
  clearRuntimeCompatibilityCacheForTests()
  vi.useRealTimers()
})

describe('sampleRuntimePtyLiveness', () => {
  it('answers every worktree on one host without overlapping its listings', async () => {
    installWorktrees({ 'wt-a': 'runtime-1', 'wt-b': 'runtime-1', 'wt-c': 'runtime-1' })
    const { maxInFlight } = installRuntime((args) =>
      later(listResponse(worktreeOf(args), [`pty-${worktreeOf(args)}`]))
    )

    const sample = await sampleRuntimePtyLiveness(useAppStore.getState())

    expect(sample.runtimeLivePtyIdsByWorktreeId).toEqual({
      'wt-a': ['h-pty-wt-a', 'pty-wt-a'],
      'wt-b': ['h-pty-wt-b', 'pty-wt-b'],
      'wt-c': ['h-pty-wt-c', 'pty-wt-c']
    })
    // A pane may be named by handle (paired client) or PTY; both resolve to the host PTY.
    expect(sample.hostPtyIdByRuntimeIdByWorktreeId['wt-a']).toEqual({
      'h-pty-wt-a': 'pty-wt-a',
      'pty-wt-a': 'pty-wt-a'
    })
    expect(sample.environmentIdByWorktreeId).toEqual({
      'wt-a': 'runtime-1',
      'wt-b': 'runtime-1',
      'wt-c': 'runtime-1'
    })
    expect(maxInFlight.get('runtime-1')).toBe(1)
  })

  it('does not overlap two concurrent samples on the same host', async () => {
    installWorktrees({ 'wt-a': 'runtime-1', 'wt-b': 'runtime-1' })
    const { maxInFlight, started } = installRuntime((args) =>
      later(listResponse(worktreeOf(args), ['p']))
    )

    const [first, second] = await Promise.all([
      sampleRuntimePtyLiveness(useAppStore.getState()),
      sampleRuntimePtyLiveness(useAppStore.getState())
    ])

    expect(started).toHaveLength(4)
    expect(maxInFlight.get('runtime-1')).toBe(1)
    expect(Object.keys(first.runtimeLivePtyIdsByWorktreeId).sort()).toEqual(['wt-a', 'wt-b'])
    expect(Object.keys(second.runtimeLivePtyIdsByWorktreeId).sort()).toEqual(['wt-a', 'wt-b'])
  })

  it('lists different hosts in parallel', async () => {
    installWorktrees({ 'wt-a': 'runtime-1', 'wt-b': 'runtime-2' })
    const pending: string[] = []
    const { started } = installRuntime((args) => {
      pending.push(args.selector)
      return new Promise(() => {})
    })

    void sampleRuntimePtyLiveness(useAppStore.getState())
    await vi.waitFor(() => expect(started).toHaveLength(2))

    expect(pending.sort()).toEqual(['runtime-1', 'runtime-2'])
  })

  it('keeps one worktree unknown without hiding a sibling the host did answer', async () => {
    installWorktrees({ 'wt-a': 'runtime-1', 'wt-b': 'runtime-1' })
    installRuntime((args) =>
      worktreeOf(args) === 'wt-a'
        ? Promise.reject(new Error('terminal_liveness_unavailable'))
        : Promise.resolve(listResponse('wt-b', ['pty-b']))
    )

    const sample = await sampleRuntimePtyLiveness(useAppStore.getState())

    expect(sample.runtimeLivePtyIdsByWorktreeId).toEqual({ 'wt-b': ['h-pty-b', 'pty-b'] })
  })

  it('records a successful empty listing as no live PTYs, not as unknown', async () => {
    installWorktrees({ 'wt-a': 'runtime-1' })
    installRuntime(() => Promise.resolve(listResponse('wt-a', [])))

    const sample = await sampleRuntimePtyLiveness(useAppStore.getState())

    expect(sample.runtimeLivePtyIdsByWorktreeId).toEqual({ 'wt-a': [] })
  })

  it('stops asking a host that spent the budget, leaving the rest unknown', async () => {
    vi.useFakeTimers()
    installWorktrees({ 'wt-a': 'runtime-1', 'wt-b': 'runtime-1' })
    const { started } = installRuntime(
      () =>
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), RUNTIME_PTY_LIVENESS_BUDGET_MS)
        )
    )

    const sampling = sampleRuntimePtyLiveness(useAppStore.getState())
    await vi.advanceTimersByTimeAsync(RUNTIME_PTY_LIVENESS_BUDGET_MS + 1)
    const sample = await sampling

    expect(started).toHaveLength(1)
    expect(sample.runtimeLivePtyIdsByWorktreeId).toEqual({})
  })

  it('waits for a listing that never returns only until its own budget', async () => {
    vi.useFakeTimers()
    installWorktrees({ 'wt-a': 'runtime-1' })
    const { started } = installRuntime(() => new Promise(() => {}))

    void sampleRuntimePtyLiveness(useAppStore.getState())
    await vi.advanceTimersByTimeAsync(1)
    const second = sampleRuntimePtyLiveness(useAppStore.getState())
    await vi.advanceTimersByTimeAsync(RUNTIME_PTY_LIVENESS_BUDGET_MS + 1)

    await expect(second).resolves.toEqual({
      runtimeLivePtyIdsByWorktreeId: {},
      hostPtyIdByRuntimeIdByWorktreeId: {},
      environmentIdByWorktreeId: {}
    })
    // The stuck listing is never overlapped by the one queued behind it.
    expect(started).toHaveLength(1)
  })

  it('asks nothing when no worktree is runtime-backed', async () => {
    useAppStore.setState({
      activeWorktreeId: null,
      repos: [],
      detectedWorktreesByRepo: {},
      worktreesByRepo: {
        'fixture-repo': [{ id: 'wt-local', repoId: 'fixture-repo', hostId: 'local' }]
      } as never,
      tabsByWorktree: { 'wt-local': [tab('wt-local')] }
    })
    installRuntime(() => Promise.resolve(listResponse('wt-local', [])))

    await sampleRuntimePtyLiveness(useAppStore.getState())

    expect(call).not.toHaveBeenCalled()
  })
})

describe('fenceRuntimePtyLivenessSample', () => {
  const sample = {
    runtimeLivePtyIdsByWorktreeId: { 'wt-a': ['pty-a', 'term_a'] },
    hostPtyIdByRuntimeIdByWorktreeId: { 'wt-a': { 'pty-a': 'pty-a', term_a: 'pty-a' } },
    environmentIdByWorktreeId: { 'wt-a': 'runtime-1' }
  }

  it('applies an answer from the host the worktree still belongs to', () => {
    installWorktrees({ 'wt-a': 'runtime-1' })
    expect(fenceRuntimePtyLivenessSample(useAppStore.getState(), sample)).toEqual({
      runtimeLivePtyIdsByWorktreeId: { 'wt-a': ['pty-a', 'term_a'] },
      runtimeHostPtyIdByRuntimeIdByWorktreeId: { 'wt-a': { 'pty-a': 'pty-a', term_a: 'pty-a' } },
      runtimeLivenessRequiredWorktreeIds: ['wt-a'],
      runtimeEnvironmentIdByWorktreeId: { 'wt-a': 'runtime-1' }
    })
  })

  it('treats an answer from a host the worktree has left as unknown', () => {
    installWorktrees({ 'wt-a': 'runtime-2' })
    expect(fenceRuntimePtyLivenessSample(useAppStore.getState(), sample)).toEqual({
      runtimeLivePtyIdsByWorktreeId: {},
      runtimeHostPtyIdByRuntimeIdByWorktreeId: {},
      runtimeLivenessRequiredWorktreeIds: ['wt-a'],
      runtimeEnvironmentIdByWorktreeId: { 'wt-a': 'runtime-2' }
    })
  })

  it('requires liveness for a runtime worktree the sample never covered', () => {
    installWorktrees({ 'wt-a': 'runtime-1', 'wt-new': 'runtime-1' })
    expect(fenceRuntimePtyLivenessSample(useAppStore.getState(), sample)).toMatchObject({
      runtimeLivePtyIdsByWorktreeId: { 'wt-a': ['pty-a', 'term_a'] },
      runtimeLivenessRequiredWorktreeIds: ['wt-a', 'wt-new'],
      runtimeEnvironmentIdByWorktreeId: { 'wt-a': 'runtime-1', 'wt-new': 'runtime-1' }
    })
  })
})
