// @vitest-environment happy-dom

import { cleanup, render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type {
  BacklogItem,
  BacklogProjectRef,
  BacklogSourceLink
} from '../../../../shared/backlog-types'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'

const mocks = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.state)
}))

import BacklogPage from './BacklogPage'

const runtimeCall = vi.fn()
let listAnswer: BacklogItem[] | 'pending' | 'storage-failed' = []

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

function ref(projectId: string): BacklogProjectRef {
  return { projectId, mapping: 'explicit', evidence: 'test' }
}

const manual: BacklogSourceLink = { kind: 'manual', ref: 'm', capturedAt: 1, candidateId: null }

function envelope(result: Record<string, unknown>) {
  return { id: 'r', ok: true, result, _meta: { runtimeId: 'local' } }
}

// P1 {a, b}, cross-project c (P1+P2), Unassigned {d, e dismissed}, f in a project the store lacks.
const STANDARD: BacklogItem[] = [
  item('a', {
    projectRefs: [ref('P1')],
    normalizedIntent: 'cafe list',
    sourceLinks: [manual],
    updatedAt: 60
  }),
  item('b', { projectRefs: [ref('P1')], state: 'ready', kind: 'engineering', updatedAt: 50 }),
  item('c', { projectRefs: [ref('P1'), ref('P2')], updatedAt: 40 }),
  item('d', { sourceLinks: [manual], updatedAt: 30 }),
  item('e', { state: 'dismissed', updatedAt: 20 }),
  item('f', { projectRefs: [ref('P9')], updatedAt: 10 })
]

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  runtimeCall.mockReset()
  listAnswer = STANDARD
  runtimeCall.mockImplementation(async ({ method }: { method: string }) => {
    if (method === 'backlog.health') {
      // The host always fills items (02-01); only openByKind/byKind are optional.
      return envelope({
        outcome: 'opened',
        items: { total: 0, byState: {} },
        candidates: { total: 0, byStatus: {} },
        quarantined: []
      })
    }
    if (listAnswer === 'pending') {
      return new Promise(() => {})
    }
    if (listAnswer === 'storage-failed') {
      return envelope({ outcome: 'storage-failed', stage: 'scan', code: 'EIO' })
    }
    return envelope({
      outcome: 'listed',
      view: 'summary',
      items: listAnswer,
      total: listAnswer.length,
      nextCursor: null,
      quarantinedCount: 0
    })
  })
  Object.assign(window, {
    api: { runtime: { call: runtimeCall }, runtimeEnvironments: { call: vi.fn() } }
  })
  mocks.state = {
    settings: { activeRuntimeEnvironmentId: null },
    projects: [
      { id: 'P1', displayName: 'Project One', badgeColor: '#111111', sourceRepoIds: [] },
      { id: 'P2', displayName: 'Project Two', badgeColor: '#222222', sourceRepoIds: [] }
    ],
    closeBacklogPage: vi.fn()
  }
})

afterEach(cleanup)

async function renderPage(): Promise<void> {
  render(
    <TooltipProvider>
      <BacklogPage />
    </TooltipProvider>
  )
  await waitFor(() =>
    expect(
      document.querySelector('[data-backlog-page]')?.getAttribute('data-backlog-status')
    ).not.toBe('loading')
  )
}

function q<T extends Element = HTMLElement>(selector: string): T | null {
  return document.body.querySelector<T>(selector)
}

function status(): string | null {
  return q('[data-backlog-page]')?.getAttribute('data-backlog-status') ?? null
}

function chipCount(scope: string): string | null {
  return q(`[data-backlog-scope="${scope}"]`)?.getAttribute('data-count') ?? null
}

function groupKeys(): string[] {
  return Array.from(document.querySelectorAll('[data-backlog-group]')).map(
    (group) => group.getAttribute('data-backlog-group') ?? ''
  )
}

function rowIds(groupKey?: string): string[] {
  const scope = groupKey ? q(`[data-backlog-group="${groupKey}"]`) : document.body
  return Array.from(scope?.querySelectorAll('[data-backlog-item-id]') ?? []).map(
    (row) => row.getAttribute('data-backlog-item-id') ?? ''
  )
}

async function choose(trigger: string, option: string): Promise<void> {
  const user = userEvent.setup()
  await user.click(q(trigger)!)
  await user.click(q(`[data-backlog-option="${option}"]`)!)
}

async function typeSearch(text: string): Promise<void> {
  const user = userEvent.setup()
  const field = q<HTMLInputElement>('[data-backlog-search]')!
  await user.clear(field)
  await user.type(field, text)
}

function expectCountsMatchText(): void {
  const claims = Array.from(document.querySelectorAll('[data-testid][data-count]'))
  expect(claims.length).toBeGreaterThan(0)
  for (const claim of claims) {
    expect(claim.textContent).toBe(claim.getAttribute('data-count'))
  }
}

describe('Backlog filter strip and header counts', () => {
  it('counts each scope from the snapshot; All counts a cross-project row once', async () => {
    await renderPage()
    expect(status()).toBe('ready')
    expect(chipCount('all')).toBe('5')
    expect(chipCount('project:P1')).toBe('3')
    expect(chipCount('project:P2')).toBe('1')
    expect(chipCount('project:P9')).toBe('1')
    expect(chipCount('unassigned')).toBe('1')
    expect(chipCount('source:manual')).toBe('2')
    expect(q('[data-backlog-scope="source:orca-conversation"]')).toBeNull()
    const scopes = Array.from(document.querySelectorAll('[data-backlog-scope]')).map((chip) =>
      chip.getAttribute('data-backlog-scope')
    )
    expect(scopes.indexOf('unassigned')).toBe(scopes.indexOf('source:manual') - 1)
    expect(scopes[0]).toBe('all')
    expect(q('[data-backlog-open-total]')?.getAttribute('data-count')).toBe('5')
    expect(q('[data-backlog-project-total]')?.getAttribute('data-count')).toBe('3')
    expect(q('[data-testid="backlog-open-total"]')?.textContent).toBe('5')
    expect(q('[data-testid="backlog-project-total"]')?.textContent).toBe('3')
    expect(q('[data-backlog-scope="unassigned"]')?.getAttribute('aria-label')).toBe(
      'Unassigned, 1 item'
    )
    expectCountsMatchText()
  })

  // Layout classes only (happy-dom has no layout); the rendered proof is
  // tests/e2e/backlog-north-star-screens.spec.ts.
  it('unknown-project chips whose ids share a long prefix keep the tail that tells them apart', async () => {
    const one = 'ghost-project-with-a-long-shared-prefix-0001'
    const two = 'ghost-project-with-a-long-shared-prefix-0002'
    listAnswer = [
      ...STANDARD,
      item('g1', { projectRefs: [ref(one)], updatedAt: 5 }),
      item('g2', { projectRefs: [ref(two)], updatedAt: 4 })
    ]
    await renderPage()
    const chip = (id: string) => q(`[data-backlog-scope="project:${id}"]`)
    expect(chipCount(`project:${one}`)).toBe('1')
    expect(chipCount(`project:${two}`)).toBe('1')
    expect(chip('P9')).not.toBeNull()

    for (const id of [one, two, 'P9']) {
      const scope = chip(id)!
      const end = id.slice(-4)
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT)
      let node = walker.nextNode()
      while (node && !node.textContent?.includes(end)) {
        node = walker.nextNode()
      }
      expect(node, `no text node carries the end of ${id}`).not.toBeNull()
      let element: HTMLElement | null = node!.parentElement
      const clipping: string[] = []
      while (element) {
        if (element.classList.contains('truncate')) {
          clipping.push(element.tagName)
        }
        if (element === scope) {
          break
        }
        element = element.parentElement
      }
      expect(clipping, `the end of ${id} sits inside a truncating element`).toEqual([])
    }

    const tails = [one, two, 'P9'].map((id) => {
      const found = chip(id)!.querySelectorAll('[data-backlog-scope-id-tail]')
      expect(found, `tail of ${id}`).toHaveLength(1)
      expect(found[0].classList.contains('shrink-0')).toBe(true)
      expect(found[0].classList.contains('font-mono')).toBe(true)
      return found[0].textContent
    })
    expect(tails).toEqual(['…prefix-0001', '…prefix-0002', 'P9'])
    expect(chip(one)?.getAttribute('aria-label')).toBe(`Unknown project ${one}, 1 item`)
    expect(chip(one)?.getAttribute('title')).toBe(one)

    expect(chip('P1')?.querySelector('[data-backlog-scope-id-tail]')).toBeNull()
    expect(chip('P1')?.textContent).toContain('Project One')
  })

  it('a scope chip shows only that scope', async () => {
    await renderPage()
    const user = userEvent.setup()
    await user.click(q('[data-backlog-scope="unassigned"]')!)
    expect(groupKeys()).toEqual(['unassigned'])
    await user.click(q('[data-backlog-scope="project:P2"]')!)
    expect(groupKeys()).toEqual(['project:P2'])
    expect(rowIds('project:P2')).toEqual(['c'])
    await waitFor(() => expect(q('[data-backlog-live-region]')?.textContent).toBe('1 item shown'))
  })

  it('state and kind filters narrow the rows and the chip counts follow', async () => {
    await renderPage()
    await choose('[data-backlog-filter="state"]', 'all')
    expect(q('[data-backlog-filter="state"]')?.getAttribute('data-value')).toBe('all')
    expect(q('[data-backlog-item-id="e"]')?.getAttribute('data-backlog-state')).toBe('dismissed')
    expect(chipCount('unassigned')).toBe('2')
    await choose('[data-backlog-filter="state"]', 'ready')
    expect(rowIds()).toEqual(['b'])
    await choose('[data-backlog-filter="state"]', 'open')
    await choose('[data-backlog-filter="kind"]', 'engineering')
    expect(rowIds()).toEqual(['b'])
    expectCountsMatchText()
  })

  it('search is case- and accent-insensitive; no match is filter-empty, and Clear keeps the sort', async () => {
    await renderPage()
    await typeSearch('CAFÉ')
    expect(rowIds()).toEqual(['a'])
    await choose('[data-backlog-sort]', 'updated-asc')
    await typeSearch('zzz nothing')
    expect(status()).toBe('filter-empty')
    expect(q('[data-backlog-notice="filter-empty"]')).not.toBeNull()
    expect(q('[data-testid="backlog-filter-empty-hidden-count"]')?.textContent).toBe('6')
    const user = userEvent.setup()
    await user.click(q('[data-backlog-action="clear-filters"]')!)
    expect(status()).toBe('ready')
    expect(q<HTMLInputElement>('[data-backlog-search]')?.value).toBe('')
    expect(q('[data-backlog-sort]')?.getAttribute('data-value')).toBe('updated-asc')
    expect(rowIds('project:P1')).toEqual(['c', 'b', 'a'])
  })

  it('only closed items: filter-empty with Show all states', async () => {
    listAnswer = [item('x', { state: 'dismissed' }), item('y', { state: 'done' })]
    await renderPage()
    expect(status()).toBe('filter-empty')
    expect(q('[data-backlog-notice="filter-empty"]')?.textContent).toContain('No open items.')
    expect(q('[data-testid="backlog-filter-empty-hidden-count"]')?.textContent).toBe('2')
    const user = userEvent.setup()
    await user.click(q('[data-backlog-action="show-all-states"]')!)
    expect(status()).toBe('ready')
    expect(q('[data-backlog-filter="state"]')?.getAttribute('data-value')).toBe('all')
    expect(rowIds().sort()).toEqual(['x', 'y'])
  })

  it('sort: Oldest first reverses a group; Priority orders urgent, high, normal, low', async () => {
    await renderPage()
    expect(q('[data-backlog-sort]')?.getAttribute('data-value')).toBe('updated-desc')
    expect(rowIds('project:P1')).toEqual(['a', 'b', 'c'])
    await choose('[data-backlog-sort]', 'updated-asc')
    expect(rowIds('project:P1')).toEqual(['c', 'b', 'a'])
    cleanup()
    listAnswer = [
      item('low', { priority: 'low', updatedAt: 40 }),
      item('normal', { priority: 'normal', updatedAt: 30 }),
      item('high', { priority: 'high', updatedAt: 20 }),
      item('urgent', { priority: 'urgent', updatedAt: 10 })
    ]
    await renderPage()
    await choose('[data-backlog-sort]', 'priority')
    expect(rowIds('unassigned')).toEqual(['urgent', 'high', 'normal', 'low'])
  })

  it('hides the count sentence while loading and on storage-failed, never shows zero', async () => {
    listAnswer = 'pending'
    render(
      <TooltipProvider>
        <BacklogPage />
      </TooltipProvider>
    )
    expect(status()).toBe('loading')
    expect(q('[data-backlog-open-total]')).toBeNull()
    expect(q('[data-backlog-scope]')).toBeNull()
    cleanup()
    listAnswer = 'storage-failed'
    await renderPage()
    expect(status()).toBe('storage-failed')
    expect(q('[data-backlog-open-total]')).toBeNull()
    expect(q('[data-backlog-project-total]')).toBeNull()
  })
})
