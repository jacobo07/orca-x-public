// @vitest-environment happy-dom

import { writeFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { create } from 'zustand'

import { createGitHubSlice } from '@/store/slices/github'
import { createHostedReviewSlice } from '@/store/slices/hosted-review'
import type { AppState } from '@/store/types'
import { useWorktreeCardLifecycleEffects } from './use-worktree-card-lifecycle-effects'

// Measures what the two worktree-card decoration polls cost as mounted cards grow, through the
// real hook and the real store fetchers, so a shared timer that still fans out per card is visible.

type HookArgs = Parameters<typeof useWorktreeCardLifecycleEffects>[0]

const WINDOW_MS = 10 * 60_000

const api = {
  hostedReview: { forBranch: vi.fn() },
  gh: { issue: vi.fn() },
  cache: { setGitHub: vi.fn() }
}

function makeStore(subjectCount: number) {
  const repos = Array.from({ length: subjectCount }, (_, i) => ({
    id: `repo-${i}`,
    path: `/repos/r${i}`,
    kind: 'git',
    connectionId: null
  }))
  return create<AppState>()(
    (...a) =>
      ({
        settings: null,
        repos,
        worktreeCardProperties: ['status', 'issue'],
        ...createGitHubSlice(...a),
        ...createHostedReviewSlice(...a)
      }) as unknown as AppState
  )
}

type Counters = { hostedFetch: number; issueFetch: number }

function cardArgs(
  store: ReturnType<typeof makeStore>,
  subject: number,
  counters: Counters
): HookArgs {
  const repo = store.getState().repos[subject]
  return {
    worktree: {
      id: `${repo.id}::wt`,
      path: `${repo.path}-wt`,
      isBare: false,
      linkedPR: null,
      head: `head-${subject}`,
      linkedIssue: 100 + subject,
      linkedLinearIssue: null
    },
    repo,
    isFolder: false,
    hostedReviewCacheKey: `hr-${subject}`,
    cachedBranchFallbackGitHubPRNumber: null,
    linkedGitLabMR: null,
    linkedBitbucketPR: null,
    linkedAzureDevOpsPR: null,
    linkedGiteaPR: null,
    branch: `feature-${subject}`,
    fetchHostedReviewForBranch: ((...args: Parameters<AppState['fetchHostedReviewForBranch']>) => {
      counters.hostedFetch++
      return store.getState().fetchHostedReviewForBranch(...args)
    }) as AppState['fetchHostedReviewForBranch'],
    shouldRefreshHostedReview: true,
    newCardStyle: false,
    hoverDetailsOpen: false,
    showIssue: true,
    issueCacheKey: `issue-${subject}`,
    fetchIssue: ((...args: Parameters<AppState['fetchIssue']>) => {
      counters.issueFetch++
      return store.getState().fetchIssue(...args)
    }) as AppState['fetchIssue'],
    showLinearIssue: false,
    fetchLinearIssue: vi.fn()
  } as unknown as HookArgs
}

type Measurement = {
  cards: number
  subjects: number
  liveIntervals: number
  hostedFetch: number
  issueFetch: number
  hostedIpc: number
  issueIpc: number
  storeWrites: number
  hiddenCalls: number
  intervalsAfterUnmount: number
}

async function measure(cards: number, cardsPerSubject: number): Promise<Measurement> {
  const subjects = Math.max(1, Math.round(cards / cardsPerSubject))
  const store = makeStore(subjects)
  const counters: Counters = { hostedFetch: 0, issueFetch: 0 }
  let storeWrites = 0
  const unsubscribeStore = store.subscribe(() => {
    storeWrites++
  })
  // Why: count live intervals, not installs; a reinstalled interval is not a second producer.
  const live = new Set<unknown>()
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms: number) => {
    const handle = realSetInterval(fn, ms)
    live.add(handle)
    return handle
  }) as typeof setInterval)
  vi.spyOn(globalThis, 'clearInterval').mockImplementation(((
    handle: ReturnType<typeof setInterval>
  ) => {
    live.delete(handle)
    realClearInterval(handle)
  }) as typeof clearInterval)

  const hooks = Array.from({ length: cards }, (_, i) =>
    renderHook(() => useWorktreeCardLifecycleEffects(cardArgs(store, i % subjects, counters)))
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(WINDOW_MS)
  })
  const liveIntervals = live.size
  const snapshot = {
    hostedFetch: counters.hostedFetch,
    issueFetch: counters.issueFetch,
    hostedIpc: api.hostedReview.forBranch.mock.calls.length,
    issueIpc: api.gh.issue.mock.calls.length
  }

  setVisibility('hidden')
  const beforeHidden = counters.hostedFetch + counters.issueFetch
  await act(async () => {
    await vi.advanceTimersByTimeAsync(WINDOW_MS)
  })
  const hiddenCalls = counters.hostedFetch + counters.issueFetch - beforeHidden
  setVisibility('visible')

  for (const hook of hooks) {
    hook.unmount()
  }
  const intervalsAfterUnmount = live.size
  unsubscribeStore()
  vi.restoreAllMocks()
  return {
    cards,
    subjects,
    liveIntervals,
    ...snapshot,
    storeWrites,
    hiddenCalls,
    intervalsAfterUnmount
  }
}

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

const curve: Record<string, Measurement> = {}

describe('worktree card decoration refresh cardinality', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
    })
    vi.setSystemTime(new Date('2026-09-17T00:00:00Z'))
    Object.assign(window, { api })
    api.hostedReview.forBranch.mockReset().mockImplementation(async (args: { branch: string }) => ({
      provider: 'github',
      number: 1,
      title: args.branch,
      state: 'open',
      url: 'https://example.invalid/pr/1',
      status: 'success',
      updatedAt: '2026-09-17T00:00:00Z',
      mergeable: 'MERGEABLE'
    }))
    api.gh.issue.mockReset().mockImplementation(async (args: { number: number }) => ({
      number: args.number,
      title: `issue ${args.number}`,
      state: 'open',
      url: `https://example.invalid/issues/${args.number}`,
      labels: []
    }))
    api.cache.setGitHub.mockReset()
    setVisibility('visible')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([1, 10, 50])('keeps one producer per window at %i distinct cards', async (cards) => {
    const m = await measure(cards, 1)
    curve[`distinct-${cards}`] = m
    expect(m.liveIntervals).toBeLessThanOrEqual(1)
    expect(m.hiddenCalls).toBe(0)
    expect(m.intervalsAfterUnmount).toBe(0)
    // Both families still reach every subject: first fetch plus the cadence ticks.
    expect(m.hostedIpc).toBeGreaterThanOrEqual(m.subjects)
    expect(m.issueIpc).toBeGreaterThanOrEqual(m.subjects)
    // The issue family keeps its 5 min cadence rather than running at the review family's 60 s.
    expect(m.issueFetch).toBeLessThanOrEqual(m.subjects * 3)
  })

  it.each([10, 50])(
    'does not fetch per card when %i cards show half as many worktrees',
    async (cards) => {
      const m = await measure(cards, 2)
      curve[`duplicated-${cards}`] = m
      expect(m.liveIntervals).toBeLessThanOrEqual(1)
      // Why: two cards for one worktree are one subject; per-card calls would double this.
      expect(m.hostedFetch).toBeLessThanOrEqual(m.subjects * 11)
      expect(m.issueFetch).toBeLessThanOrEqual(m.subjects * 3)
    }
  )

  afterEach(() => {
    const out = process.env.ORCA_SIDEBAR_CURVE_OUT
    if (out) {
      writeFileSync(out, JSON.stringify(curve, null, 2))
    }
  })
})
