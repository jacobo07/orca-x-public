// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { BacklogItem, BacklogProjectRef } from '../../../../shared/backlog-types'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  closeBacklogPage: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.state)
}))

import BacklogPage from './BacklogPage'

type ListAnswer = { items: BacklogItem[] } | { failure: Record<string, unknown> } | 'pending'

const runtimeCall = vi.fn()
let listAnswer: ListAnswer = { items: [] }
let container: HTMLDivElement
let root: Root

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

function envelope(result: Record<string, unknown>) {
  return { id: 'r', ok: true, result, _meta: { runtimeId: 'local' } }
}

function listCalls(): number {
  return runtimeCall.mock.calls.filter(([args]) => args.method === 'backlog.list').length
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function renderPage(): Promise<void> {
  act(() => {
    root.render(
      <TooltipProvider>
        <BacklogPage />
      </TooltipProvider>
    )
  })
  await flush()
}

function page(): HTMLElement {
  return container.querySelector<HTMLElement>('[data-backlog-page]')!
}

function rowsIn(groupKey: string): string[] {
  const group = container.querySelector(`[data-backlog-group="${groupKey}"]`)
  return Array.from(group?.querySelectorAll('[data-backlog-item-id]') ?? []).map(
    (row) => row.getAttribute('data-backlog-item-id') ?? ''
  )
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  runtimeCall.mockReset()
  mocks.closeBacklogPage.mockReset()
  listAnswer = { items: [] }
  runtimeCall.mockImplementation(async ({ method }: { method: string }) => {
    if (method === 'backlog.health') {
      return envelope({ outcome: 'opened', quarantined: [] })
    }
    if (listAnswer === 'pending') {
      return new Promise(() => {})
    }
    if ('failure' in listAnswer) {
      return listAnswer.failure
    }
    return envelope({
      outcome: 'listed',
      view: 'summary',
      items: listAnswer.items,
      total: listAnswer.items.length,
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
    closeBacklogPage: mocks.closeBacklogPage
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('BacklogPage', () => {
  it('shows loading while the first list is pending, never an empty list', async () => {
    listAnswer = 'pending'
    await renderPage()
    expect(page().getAttribute('data-backlog-status')).toBe('loading')
    expect(container.querySelector('[data-backlog-group]')).toBeNull()
  })

  it('renders empty only from a successful list with total 0', async () => {
    await renderPage()
    expect(page().getAttribute('data-backlog-status')).toBe('empty')
  })

  it('groups rows by project with Unassigned last, a cross-project row in both groups', async () => {
    listAnswer = {
      items: [
        item('bli_p1', { projectRefs: [ref('P1')], updatedAt: 40 }),
        item('bli_p2', { projectRefs: [ref('P2')], updatedAt: 30 }),
        item('bli_cross', { projectRefs: [ref('P1'), ref('P2')], updatedAt: 20 }),
        item('bli_none', { updatedAt: 50 }),
        item('bli_ghost', { projectRefs: [ref('P9')], updatedAt: 10 })
      ]
    }
    await renderPage()
    expect(page().getAttribute('data-backlog-status')).toBe('ready')
    const groupKeys = Array.from(container.querySelectorAll('[data-backlog-group]')).map((group) =>
      group.getAttribute('data-backlog-group')
    )
    expect(groupKeys).toEqual(['project:P1', 'project:P2', 'unknown:P9', 'unassigned'])
    expect(rowsIn('project:P1')).toEqual(['bli_p1', 'bli_cross'])
    expect(rowsIn('project:P2')).toEqual(['bli_p2', 'bli_cross'])
    expect(rowsIn('unassigned')).toEqual(['bli_none'])
    expect(rowsIn('unknown:P9')).toEqual(['bli_ghost'])
    const cross = container.querySelectorAll('[data-backlog-item-id="bli_cross"]')
    expect(cross).toHaveLength(2)
    expect(cross[0].getAttribute('data-backlog-cross-project')).toBe('true')
    expect(
      container
        .querySelector('[data-backlog-item-id="bli_p1"]')
        ?.getAttribute('data-backlog-cross-project')
    ).toBe('false')
    expect(
      container.querySelector('[data-backlog-group="project:P1"]')?.getAttribute('data-count')
    ).toBe('2')
  })

  it('hides a dismissed row in the default Open view and shows needs-triage and ready rows', async () => {
    listAnswer = {
      items: [
        item('bli_triage'),
        item('bli_ready', { state: 'ready' }),
        item('bli_gone', { state: 'dismissed' })
      ]
    }
    await renderPage()
    expect(page().getAttribute('data-backlog-status')).toBe('ready')
    expect(rowsIn('unassigned').sort()).toEqual(['bli_ready', 'bli_triage'])
    expect(container.querySelector('[data-backlog-item-id="bli_gone"]')).toBeNull()
  })

  it('renders item text as text, never as markup', async () => {
    const hostile = '<img src=x onerror=alert(1)>'
    listAnswer = { items: [item('bli_xss', { originalText: hostile })] }
    await renderPage()
    expect(container.querySelectorAll('img')).toHaveLength(0)
    expect(container.querySelector('[data-backlog-item-id="bli_xss"]')?.textContent).toContain(
      hostile
    )
  })

  it('renders storage-failed with its stage and code, no rows, never empty; Retry lists once more', async () => {
    listAnswer = { failure: envelope({ outcome: 'storage-failed', stage: 'scan', code: 'EIO' }) }
    await renderPage()
    expect(page().getAttribute('data-backlog-status')).toBe('storage-failed')
    expect(page().getAttribute('data-backlog-failure-stage')).toBe('scan')
    expect(page().getAttribute('data-backlog-failure-code')).toBe('EIO')
    expect(container.querySelector('[data-backlog-item-id]')).toBeNull()
    expect(container.textContent).not.toContain('EIO')
    const before = listCalls()
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-backlog-action="retry"]')!.click()
    })
    await flush()
    expect(listCalls()).toBe(before + 1)
    expect(page().getAttribute('data-backlog-status')).toBe('storage-failed')
  })

  it('gives capability-unsupported, forbidden and unreachable their own status', async () => {
    const cases: [Record<string, unknown>, string, boolean][] = [
      [{ id: 'r', ok: false, error: { code: 'method_not_found', message: 'x' } }, 'capability-unsupported', false],
      [{ id: 'r', ok: false, error: { code: 'forbidden', message: 'x' } }, 'forbidden', false],
      [envelope({ outcome: 'something-else' }), 'unreachable', true]
    ]
    for (const [failure, status, retryable] of cases) {
      listAnswer = { failure }
      await renderPage()
      expect(page().getAttribute('data-backlog-status')).toBe(status)
      expect(container.querySelector('[data-backlog-action="retry"]') !== null).toBe(retryable)
      act(() => root.unmount())
      root = createRoot(container)
    }
  })

  it('unreachable Retry triggers exactly one new list call', async () => {
    listAnswer = { failure: envelope({ outcome: 'something-else' }) }
    await renderPage()
    const before = listCalls()
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-backlog-action="retry"]')!.click()
    })
    await flush()
    expect(listCalls()).toBe(before + 1)
  })

  it('Close calls closeBacklogPage once', async () => {
    await renderPage()
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-backlog-action="close"]')!.click()
    })
    expect(mocks.closeBacklogPage).toHaveBeenCalledTimes(1)
  })
})

describe('BacklogRow labels', () => {
  function chip(id: string, name: string): string | null {
    return (
      container
        .querySelector(`[data-backlog-item-id="${id}"] [data-backlog-chip="${name}"]`)
        ?.textContent?.trim() ?? null
    )
  }

  it('labels source, state and priority from one presenter; normal priority has no chip', async () => {
    listAnswer = {
      items: [
        item('bli_manual', {
          priority: 'urgent',
          sourceLinks: [{ kind: 'manual', ref: 'm1', capturedAt: 1, candidateId: null }]
        }),
        item('bli_plain', { state: 'ready' })
      ]
    }
    await renderPage()
    expect(chip('bli_manual', 'source')).toBe('Manual')
    expect(chip('bli_manual', 'state')).toBe('Needs triage')
    expect(chip('bli_manual', 'priority')).toBe('Urgent')
    expect(chip('bli_plain', 'source')).toBeNull()
    expect(chip('bli_plain', 'state')).toBe('Ready')
    expect(chip('bli_plain', 'priority')).toBeNull()
  })

  it('falls back to the kind label for a single-line text, and manual reads Manual task', async () => {
    listAnswer = {
      items: [
        item('bli_one_line', { kind: 'manual', originalText: 'only line' }),
        item('bli_two_lines', { kind: 'manual', originalText: 'first\nsecond line' })
      ]
    }
    await renderPage()
    const secondary = (id: string) =>
      container
        .querySelector(`[data-backlog-item-id="${id}"] [data-backlog-row-secondary]`)
        ?.textContent?.trim()
    expect(secondary('bli_one_line')).toBe('Manual task')
    expect(secondary('bli_two_lines')).toBe('second line')
  })
})
