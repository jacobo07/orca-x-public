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
// When set, the next backlog.list calls are answered by it instead of listAnswer.
let listOverride: (() => Promise<unknown>) | null = null
let healthResult: Record<string, unknown> = {}
let captureAnswer: () => Promise<unknown> = async () => ({})

const ZERO_BY_KIND = { engineering: 0, research: 0, decision: 0, manual: 0, idea: 0 }

function openedHealth(quarantined: Record<string, unknown>[] = []): Record<string, unknown> {
  return {
    outcome: 'opened',
    items: { total: 0, byState: {}, byKind: ZERO_BY_KIND, openByKind: ZERO_BY_KIND },
    candidates: { total: 0, byStatus: {} },
    quarantined
  }
}

type Deferred = { promise: Promise<unknown>; resolve: (value: unknown) => void }

function deferred(): Deferred {
  let resolve: (value: unknown) => void = () => {}
  const promise = new Promise<unknown>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function listed(items: BacklogItem[], total = items.length) {
  return envelope({
    outcome: 'listed',
    view: 'summary',
    items,
    total,
    nextCursor: null,
    quarantinedCount: 0
  })
}
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
  listOverride = null
  healthResult = openedHealth()
  runtimeCall.mockImplementation(async ({ method }: { method: string }) => {
    if (method === 'backlog.health') {
      return envelope(healthResult)
    }
    if (method === 'backlog.capture') {
      return captureAnswer()
    }
    if (listOverride) {
      return listOverride()
    }
    if (listAnswer === 'pending') {
      return new Promise(() => {})
    }
    if ('failure' in listAnswer) {
      return listAnswer.failure
    }
    return listed(listAnswer.items)
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
      [
        { id: 'r', ok: false, error: { code: 'method_not_found', message: 'x' } },
        'capability-unsupported',
        false
      ],
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

  it('the secondary line is always the kind label, never a second text line (R-11), and manual reads Manual task', async () => {
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
    expect(secondary('bli_two_lines')).toBe('Manual task')
  })
})

describe('BacklogPage capture', () => {
  function captureDialog(): HTMLElement | null {
    return document.body.querySelector<HTMLElement>('[data-backlog-capture-dialog]')
  }

  async function click(selector: string): Promise<void> {
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>(selector)!.click()
    })
    await flush()
  }

  async function captureText(text: string): Promise<void> {
    await click('[data-backlog-action="capture"]')
    const field = document.body.querySelector<HTMLTextAreaElement>(
      '[data-backlog-capture-field="text"]'
    )!
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    act(() => {
      setter.call(field, text)
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click('[data-backlog-capture-submit]')
  }

  it('opens the dialog from the header and from the empty-state CTA', async () => {
    await renderPage()
    expect(page().getAttribute('data-backlog-status')).toBe('empty')
    expect(captureDialog()).toBeNull()
    await click('[data-backlog-action="capture-empty"]')
    expect(captureDialog()).not.toBeNull()
    act(() => root.unmount())
    root = createRoot(container)
    await renderPage()
    expect(captureDialog()).toBeNull()
    await click('[data-backlog-action="capture"]')
    expect(captureDialog()).not.toBeNull()
  })

  it('a confirmed capture refetches the list exactly once', async () => {
    captureAnswer = async () => envelope({ outcome: 'published', record: item('bli_new') })
    await renderPage()
    const before = listCalls()
    await captureText('new idea')
    expect(captureDialog()?.getAttribute('data-backlog-capture-status')).toBe('confirmed')
    expect(listCalls()).toBe(before + 1)
  })

  it('an unknown capture refetches once and keeps the text; storage-failed refetches nothing', async () => {
    captureAnswer = async () => {
      throw new Error('reply lost')
    }
    await renderPage()
    let before = listCalls()
    await captureText('maybe saved')
    expect(captureDialog()?.getAttribute('data-backlog-capture-failure')).toBe('unknown')
    expect(
      document.body.querySelector<HTMLTextAreaElement>('[data-backlog-capture-field="text"]')!.value
    ).toBe('maybe saved')
    expect(listCalls()).toBe(before + 1)
    expect(
      runtimeCall.mock.calls.filter(([args]) => args.method === 'backlog.capture')
    ).toHaveLength(1)

    act(() => root.unmount())
    root = createRoot(container)
    captureAnswer = async () =>
      envelope({ outcome: 'storage-failed', stage: 'publish', code: null })
    await renderPage()
    before = listCalls()
    await captureText('not saved')
    expect(captureDialog()?.getAttribute('data-backlog-capture-failure')).toBe('storage-failed')
    expect(listCalls()).toBe(before)
  })
})

describe('BacklogPage refresh model and notices', () => {
  function healthCalls(): number {
    return runtimeCall.mock.calls.filter(([args]) => args.method === 'backlog.health').length
  }

  function focusWindow(): void {
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
  }

  function notice(name: string): HTMLElement | null {
    return container.querySelector<HTMLElement>(`[data-backlog-notice="${name}"]`)
  }

  async function click(selector: string): Promise<void> {
    await act(async () => {
      container.querySelector<HTMLButtonElement>(selector)!.click()
    })
    await flush()
  }

  it('mount lists once; focus refetches, but not while a sequence is in flight or after unmount', async () => {
    listAnswer = { items: [item('bli_a')] }
    await renderPage()
    expect(listCalls()).toBe(1)
    expect(healthCalls()).toBe(1)
    const pending = deferred()
    listOverride = () => pending.promise
    focusWindow()
    await flush()
    expect(listCalls()).toBe(2)
    focusWindow()
    await flush()
    expect(listCalls()).toBe(2)
    await act(async () => {
      pending.resolve(listed([item('bli_a')]))
    })
    await flush()
    act(() => root.unmount())
    root = createRoot(container)
    focusWindow()
    await flush()
    expect(listCalls()).toBe(2)
  })

  it('an older sequence resolving late never replaces the newer rows', async () => {
    // Four rows for a ledger total of five: the count-mismatch notice offers an explicit refresh.
    listAnswer = { items: [item('bli_v1'), item('bli_x'), item('bli_y'), item('bli_z')] }
    listOverride = async () =>
      listed([item('bli_v1'), item('bli_x'), item('bli_y'), item('bli_z')], 5)
    await renderPage()
    const older = deferred()
    const newer = deferred()
    const queue = [older, newer]
    listOverride = () => queue.shift()!.promise
    focusWindow()
    await click('[data-backlog-action="reconcile"]')
    expect(listCalls()).toBe(3)
    await act(async () => {
      newer.resolve(listed([item('bli_newer')]))
    })
    await flush()
    await act(async () => {
      older.resolve(listed([item('bli_older')]))
    })
    await flush()
    expect(rowsIn('unassigned')).toEqual(['bli_newer'])
  })

  it('a failed refetch keeps the rows and says so without the stage or code; Retry refetches once', async () => {
    listAnswer = { items: [item('bli_kept')] }
    await renderPage()
    listOverride = async () => envelope({ outcome: 'storage-failed', stage: 'scan', code: 'EIO' })
    focusWindow()
    await flush()
    expect(page().getAttribute('data-backlog-status')).toBe('ready')
    expect(rowsIn('unassigned')).toEqual(['bli_kept'])
    const failed = notice('refresh-failed')
    expect(failed).not.toBeNull()
    expect(failed?.textContent).not.toContain('scan')
    expect(failed?.textContent).not.toContain('EIO')
    const before = listCalls()
    await click('[data-backlog-action="retry"]')
    expect(listCalls()).toBe(before + 1)
  })

  it('renders the first-load loader only after 200 ms', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      listAnswer = 'pending'
      act(() => {
        root.render(
          <TooltipProvider>
            <BacklogPage />
          </TooltipProvider>
        )
      })
      act(() => {
        vi.advanceTimersByTime(150)
      })
      expect(page().getAttribute('data-backlog-status')).toBe('loading')
      expect(container.querySelector('[data-backlog-loading]')).toBeNull()
      act(() => {
        vi.advanceTimersByTime(100)
      })
      expect(container.querySelector('[data-backlog-loading]')).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('states quarantined records across items and candidates; the report is copied only on click', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    healthResult = openedHealth([
      { recordKind: 'item', fileName: 'bli_bad.json', id: 'bli_bad', code: 'parse', reason: 'x' },
      { recordKind: 'candidate', fileName: 'blc_bad.json', id: null, code: 'schema', reason: 'y' }
    ])
    listAnswer = { items: [item('bli_ok')] }
    await renderPage()
    const quarantined = notice('quarantined')
    expect(quarantined).not.toBeNull()
    expect(
      quarantined?.querySelector('[data-testid="backlog-notice-quarantined-count"]')?.textContent
    ).toBe('2')
    expect(quarantined?.textContent).toContain('items and candidates')
    expect(writeText).not.toHaveBeenCalled()
    await click('[data-backlog-action="copy-quarantine"]')
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith(
      JSON.stringify(
        [
          { recordKind: 'item', fileName: 'bli_bad.json', id: 'bli_bad', code: 'parse' },
          { recordKind: 'candidate', fileName: 'blc_bad.json', id: null, code: 'schema' }
        ],
        null,
        2
      )
    )
  })

  it('shows both numbers when the deduped rows differ from the ledger total', async () => {
    listOverride = async () =>
      listed([item('bli_1'), item('bli_1'), item('bli_2'), item('bli_3'), item('bli_4')], 5)
    await renderPage()
    const mismatch = notice('count-mismatch')
    expect(mismatch).not.toBeNull()
    expect(
      mismatch?.querySelector('[data-testid="backlog-notice-snapshot-count"]')?.textContent
    ).toBe('4')
    expect(
      mismatch?.querySelector('[data-testid="backlog-notice-ledger-total"]')?.textContent
    ).toBe('5')
  })
})
