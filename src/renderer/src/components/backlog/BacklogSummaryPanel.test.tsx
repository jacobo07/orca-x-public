// @vitest-environment happy-dom

import { cleanup, render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { BacklogItem } from '../../../../shared/backlog-types'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'

const mocks = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.state)
}))

import BacklogPage from './BacklogPage'

const runtimeCall = vi.fn()
let healthAnswer: () => unknown = () => ({})
let items: BacklogItem[] = []

function item(id: string, overrides: Partial<BacklogItem> = {}): BacklogItem {
  return {
    schemaVersion: 1,
    id,
    kind: 'idea',
    originalText: `text of ${id}`,
    normalizedIntent: '',
    projectRefs: [],
    state: 'needs-triage',
    priority: 'normal',
    dependencies: [],
    executorPolicy: null,
    sourceLinks: [],
    executionLinks: [],
    evidence: [],
    events: [],
    mergedInto: null,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function envelope(result: Record<string, unknown>) {
  return { id: 'r', ok: true, result, _meta: { runtimeId: 'local' } }
}

const BY_STATE = {
  'needs-triage': 3,
  ready: 0,
  'waiting-for-executor': 0,
  preparing: 0,
  running: 0,
  review: 0,
  done: 2,
  blocked: 1,
  stale: 0,
  superseded: 0,
  dismissed: 0,
  unknown: 0
}
const OPEN_BY_KIND = { engineering: 1, research: 0, decision: 2, manual: 0, idea: 1 }

function health(extra: { openByKind?: boolean; quarantined?: Record<string, unknown>[] } = {}) {
  return envelope({
    outcome: 'opened',
    items: {
      total: 6,
      byState: BY_STATE,
      ...(extra.openByKind === false
        ? {}
        : { byKind: { ...OPEN_BY_KIND, idea: 3 }, openByKind: OPEN_BY_KIND })
    },
    candidates: { total: 0, byStatus: {} },
    quarantined: extra.quarantined ?? []
  })
}

function healthCalls(): number {
  return runtimeCall.mock.calls.filter(([args]) => args.method === 'backlog.health').length
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  runtimeCall.mockReset()
  items = [item('bli_a'), item('bli_blocked', { state: 'blocked' }), item('bli_ready', { state: 'ready' })]
  healthAnswer = () => health()
  runtimeCall.mockImplementation(async ({ method }: { method: string }) => {
    if (method === 'backlog.health') {
      return healthAnswer()
    }
    return envelope({
      outcome: 'listed',
      view: 'summary',
      items,
      total: items.length,
      nextCursor: null,
      quarantinedCount: 0
    })
  })
  Object.assign(window, {
    api: { runtime: { call: runtimeCall }, runtimeEnvironments: { call: vi.fn() } }
  })
  mocks.state = {
    settings: { activeRuntimeEnvironmentId: null },
    projects: [],
    closeBacklogPage: vi.fn()
  }
})

afterEach(cleanup)

function q<T extends Element = HTMLElement>(selector: string): T | null {
  return document.body.querySelector<T>(selector)
}

async function renderPage(summaryStatus: string): Promise<HTMLElement> {
  render(
    <TooltipProvider>
      <BacklogPage />
    </TooltipProvider>
  )
  await waitFor(() =>
    expect(q('[data-backlog-summary]')?.getAttribute('data-backlog-summary-status')).toBe(
      summaryStatus
    )
  )
  return q('[data-backlog-summary]')!
}

describe('BacklogSummaryPanel', () => {
  it('reads open by kind, non-zero states with tone marks, the total and no quarantine row', async () => {
    const aside = await renderPage('ready')
    expect(aside.tagName).toBe('ASIDE')
    expect(aside.getAttribute('aria-label')).toBe('Backlog summary')
    for (const [kind, count] of Object.entries(OPEN_BY_KIND)) {
      const row = aside.querySelector(`[data-backlog-summary-kind="${kind}"]`)
      expect(row?.getAttribute('data-count'), kind).toBe(String(count))
      expect(row?.querySelector('[data-testid="backlog-summary-kind-count"]')?.textContent).toBe(
        String(count)
      )
    }
    const states = Array.from(aside.querySelectorAll('[data-backlog-summary-state]')).map((row) => [
      row.getAttribute('data-backlog-summary-state'),
      row.getAttribute('data-count')
    ])
    expect(states).toEqual([
      ['needs-triage', '3'],
      ['done', '2'],
      ['blocked', '1']
    ])
    expect(
      aside
        .querySelector('[data-backlog-summary-state="blocked"] [data-backlog-tone-mark]')
        ?.getAttribute('data-backlog-tone-mark')
    ).toBe('critical')
    const total = aside.querySelector('[data-backlog-summary-total]')
    expect(total?.getAttribute('data-count')).toBe('6')
    expect(total?.getAttribute('data-count')).toBe(
      String(Object.values(BY_STATE).reduce((sum, n) => sum + n, 0))
    )
    expect(aside.querySelector('[data-backlog-summary-quarantined]')).toBeNull()
  })

  it('an older host without openByKind reads "not recorded" with the unknown mark, never 0', async () => {
    healthAnswer = () => health({ openByKind: false })
    const aside = await renderPage('ready')
    const kinds = aside.querySelector('[data-backlog-summary-kinds]')!
    expect(kinds).not.toBeNull()
    for (const kind of Object.keys(OPEN_BY_KIND)) {
      const row = kinds.querySelector(`[data-backlog-summary-kind="${kind}"]`)
      expect(row?.getAttribute('data-count-status'), kind).toBe('unknown')
      expect(row?.textContent).toContain('not recorded')
      expect(row?.querySelector('[data-backlog-tone-mark="unknown"]')).not.toBeNull()
    }
    expect(kinds.querySelector('[data-count="0"]')).toBeNull()
  })

  it('shows a Quarantined row only when records were quarantined', async () => {
    healthAnswer = () =>
      health({
        quarantined: [
          { recordKind: 'item', fileName: 'bli_x.json', id: 'bli_x', code: 'parse', reason: 'r' }
        ]
      })
    const aside = await renderPage('ready')
    const row = aside.querySelector('[data-backlog-summary-quarantined]')
    expect(row?.getAttribute('data-count')).toBe('1')
    expect(row?.querySelector('[data-backlog-tone-mark="critical"]')).not.toBeNull()
  })

  it('a failed health read says the summary is unavailable while the list stays; Retry summary reads health once', async () => {
    healthAnswer = () => envelope({ outcome: 'something-else' })
    const aside = await renderPage('unavailable')
    expect(aside.textContent).toContain('Summary unavailable. The item list above is still current.')
    expect(q('[data-backlog-page]')?.getAttribute('data-backlog-status')).toBe('ready')
    expect(q('[data-backlog-item-id="bli_a"]')).not.toBeNull()
    const listCalls = runtimeCall.mock.calls.filter(([args]) => args.method === 'backlog.list').length
    const before = healthCalls()
    healthAnswer = () => health()
    await userEvent.setup().click(q('[data-backlog-action="retry-summary"]')!)
    await waitFor(() =>
      expect(q('[data-backlog-summary]')?.getAttribute('data-backlog-summary-status')).toBe('ready')
    )
    expect(healthCalls()).toBe(before + 1)
    expect(runtimeCall.mock.calls.filter(([args]) => args.method === 'backlog.list')).toHaveLength(
      listCalls
    )
  })

  it('row state chips carry a tone mark beside a label that is always present', async () => {
    await renderPage('ready')
    const mark = (id: string) =>
      q(`[data-backlog-item-id="${id}"] [data-backlog-chip="state"] [data-backlog-tone-mark]`)
    expect(mark('bli_blocked')?.getAttribute('data-backlog-tone-mark')).toBe('critical')
    expect(mark('bli_blocked')?.getAttribute('data-mark')).toBe('filled')
    expect(mark('bli_a')?.getAttribute('data-backlog-tone-mark')).toBe('pressured')
    expect(mark('bli_ready')).toBeNull()
    expect(
      q('[data-backlog-item-id="bli_ready"] [data-backlog-chip="state"]')?.textContent?.trim()
    ).toBe('Ready')
    expect(
      q('[data-backlog-item-id="bli_blocked"] [data-backlog-chip="state"]')?.textContent?.trim()
    ).toBe('Blocked')
  })
})
