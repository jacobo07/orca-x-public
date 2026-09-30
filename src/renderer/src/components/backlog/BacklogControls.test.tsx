// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { BacklogItem } from '../../../../shared/backlog-types'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  closeBacklogPage: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.state)
}))

vi.mock('sonner', () => ({ toast: vi.fn() }))

import BacklogPage from './BacklogPage'

// Every action handle the surface may render. A new value fails until it is classified here with
// the effect it produces; a value that disappears from the source fails as stale.
const ACTION_ALLOW_LIST = [
  'close',
  'capture',
  'capture-empty',
  'retry',
  'retry-summary',
  'clear-filters',
  'show-all-states',
  'copy-quarantine',
  'reconcile',
  'change-state',
  'edit',
  'save-edit',
  'discard-edit'
] as const

const SOURCES = import.meta.glob('./*.tsx', { query: '?raw', import: 'default', eager: true })

const runtimeCall = vi.fn()
let items: BacklogItem[] = []
let listTotal: number | null = null
let listFails = false
let healthFails = false
let quarantined: Record<string, unknown>[] = []

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

function calls(method: string): number {
  return runtimeCall.mock.calls.filter(([args]) => args.method === method).length
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  runtimeCall.mockReset()
  mocks.closeBacklogPage.mockReset()
  items = [
    item('a', { projectRefs: [{ projectId: 'P1', mapping: 'explicit', evidence: '' }] }),
    item('b', { updatedAt: 2 })
  ]
  listTotal = null
  listFails = false
  healthFails = false
  quarantined = []
  runtimeCall.mockImplementation(
    async ({ method, params }: { method: string; params: Record<string, unknown> }) => {
      if (method === 'backlog.health') {
        return envelope(
          healthFails
            ? { outcome: 'something-else' }
            : {
                outcome: 'opened',
                items: { total: items.length, byState: {} },
                candidates: { total: 0, byStatus: {} },
                quarantined
              }
        )
      }
      if (method === 'backlog.get') {
        return envelope({ outcome: 'loaded', record: items.find((row) => row.id === params.id) })
      }
      if (method === 'backlog.update' || method === 'backlog.capture') {
        return envelope({ outcome: 'published', record: items[0] })
      }
      if (listFails) {
        return envelope({ outcome: 'something-else' })
      }
      return envelope({
        outcome: 'listed',
        view: 'summary',
        items,
        total: listTotal ?? items.length,
        nextCursor: null,
        quarantinedCount: 0
      })
    }
  )
  Object.assign(window, {
    api: { runtime: { call: runtimeCall }, runtimeEnvironments: { call: vi.fn() } }
  })
  mocks.state = {
    settings: { activeRuntimeEnvironmentId: null },
    activeRepoId: null,
    projects: [
      { id: 'P1', displayName: 'Project One', badgeColor: '#111111', sourceRepoIds: ['r1'] }
    ],
    closeBacklogPage: mocks.closeBacklogPage
  }
})

afterEach(cleanup)

function q<T extends Element = HTMLElement>(selector: string, scope: ParentNode = document) {
  return scope.querySelector<T>(selector)
}

function status(): string | null {
  return q('[data-backlog-page]')?.getAttribute('data-backlog-status') ?? null
}

async function renderPage(expected = 'ready'): Promise<void> {
  render(
    <TooltipProvider>
      <BacklogPage />
    </TooltipProvider>
  )
  await waitFor(() => expect(status()).toBe(expected))
}

async function click(selector: string): Promise<void> {
  await userEvent.setup().click(q(selector)!)
}

async function expandRow(id: string): Promise<HTMLElement> {
  await click(`[data-backlog-item-id="${id}"] [data-backlog-row-toggle]`)
  await waitFor(() =>
    expect(
      q(`[data-backlog-item-id="${id}"] [data-backlog-item-detail]`)?.getAttribute(
        'data-backlog-detail-status'
      )
    ).toBe('loaded')
  )
  return q(`[data-backlog-item-id="${id}"]`)!
}

function key(target: EventTarget, init: KeyboardEventInit): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
  })
}

const CONTROL_SELECTOR =
  'button, [role="menuitem"], [role="option"], [role="switch"], [role="combobox"], input, textarea'

function hasBacklogHandle(element: Element): boolean {
  return element.getAttributeNames().some((name) => name.startsWith('data-backlog-'))
}

function unhandledControls(scope: Element): string[] {
  return Array.from(scope.querySelectorAll(CONTROL_SELECTOR))
    .filter((control) => !control.closest('[aria-hidden="true"]'))
    .filter((control) => !hasBacklogHandle(control))
    .map((control) => control.outerHTML.slice(0, 120))
}

function renderedActions(): string[] {
  return Array.from(document.querySelectorAll('[data-backlog-action]')).map(
    (control) => control.getAttribute('data-backlog-action') ?? ''
  )
}

describe('page keys', () => {
  it('N on the page body opens capture; Esc closes it and returns focus to the Capture button', async () => {
    await renderPage()
    key(document.body, { key: 'n' })
    await waitFor(() => expect(q('[data-backlog-capture-dialog]')).not.toBeNull())
    key(q('[data-backlog-capture-field="text"]')!, { key: 'Escape' })
    await waitFor(() => expect(q('[data-backlog-capture-dialog]')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(q('[data-backlog-action="capture"]')))
    expect(mocks.closeBacklogPage).not.toHaveBeenCalled()
  })

  it('N does nothing with a modifier, while composing, in the search field, in a terminal, or with a layer open', async () => {
    await renderPage()
    // Checked after EVERY key: a later Escape would close a dialog a wrong N had opened.
    const expectIgnored = (target: EventTarget, init: KeyboardEventInit): void => {
      key(target, init)
      expect(q('[data-backlog-capture-dialog]')).toBeNull()
      expect(mocks.closeBacklogPage).not.toHaveBeenCalled()
    }
    for (const init of [
      { key: 'n', ctrlKey: true },
      { key: 'n', metaKey: true },
      { key: 'n', altKey: true },
      { key: 'n', isComposing: true }
    ]) {
      expectIgnored(document.body, init)
    }
    expectIgnored(q('[data-backlog-search]')!, { key: 'n' })
    const terminal = document.createElement('div')
    terminal.className = 'xterm'
    const helper = document.createElement('div')
    helper.tabIndex = 0
    terminal.appendChild(helper)
    document.body.appendChild(terminal)
    expectIgnored(helper, { key: 'n' })
    expectIgnored(helper, { key: 'Escape' })
    terminal.remove()
    await click('[data-backlog-filter="kind"]')
    await waitFor(() => expect(q('[data-slot="select-content"]')).not.toBeNull())
    expectIgnored(document.body, { key: 'n' })
    expectIgnored(document.body, { key: 'Escape' })
    // Control: with no layer and no modifier, the same key does open capture.
    await waitFor(() => expect(q('[data-slot="select-content"]')).toBeNull())
    key(document.body, { key: 'n' })
    expect(q('[data-backlog-capture-dialog]')).not.toBeNull()
  })

  it('Esc in the search field clears it and blurs; Esc on the page body closes Backlog once', async () => {
    await renderPage()
    const search = q<HTMLInputElement>('[data-backlog-search]')!
    await userEvent.setup().type(search, 'abc')
    expect(document.activeElement).toBe(search)
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(search.value).toBe('')
    expect(document.activeElement).not.toBe(search)
    expect(mocks.closeBacklogPage).not.toHaveBeenCalled()
    key(document.body, { key: 'Escape' })
    expect(mocks.closeBacklogPage).toHaveBeenCalledTimes(1)
  })

  it('the promised copy holds: Close reads "Close · Esc" and the empty state says Press N', async () => {
    await renderPage()
    act(() => q<HTMLButtonElement>('[data-backlog-action="close"]')!.focus())
    await waitFor(() => expect(document.body.textContent).toContain('Close · Esc'))
    cleanup()
    items = []
    await renderPage('empty')
    expect(document.body.textContent).toContain('Press N to capture from anywhere on this page.')
  })
})

describe('no decorative control', () => {
  it('every action value in the source is on the allow-list, and every allow-listed value exists', () => {
    const found = new Set<string>()
    for (const [path, source] of Object.entries(SOURCES)) {
      if (path.includes('.test.')) {
        continue
      }
      for (const match of (source as string).matchAll(/data-backlog-action="([^"]+)"/g)) {
        found.add(match[1])
      }
    }
    // Positive control: the sweep read the sources and found the handles it guards.
    expect(found.size).toBeGreaterThanOrEqual(ACTION_ALLOW_LIST.length)
    expect([...found].sort()).toEqual([...ACTION_ALLOW_LIST].sort())
  })

  it('every control on the ready page, an expanded row, an edit form and the dialog carries a handle', async () => {
    items = [...items, item('c', { kind: 'engineering', updatedAt: 3 })]
    await renderPage()
    await expandRow('a')
    const editRow = await expandRow('c')
    await click('[data-backlog-item-id="c"] [data-backlog-action="edit"]')
    await waitFor(() => expect(q('[data-backlog-edit-form]', editRow)).not.toBeNull())
    const page = q('[data-backlog-page]')!
    expect(page.querySelectorAll(CONTROL_SELECTOR).length).toBeGreaterThan(10)
    expect(unhandledControls(page)).toEqual([])
    for (const value of renderedActions()) {
      expect(ACTION_ALLOW_LIST).toContain(value)
    }
    // D-11: no row checkbox, and no executor / run / triage / import / source-configuration action.
    expect(q('[data-backlog-item-id]', page)).not.toBeNull()
    expect(page.querySelector('input[type="checkbox"], [role="checkbox"]')).toBeNull()
    for (const value of renderedActions()) {
      expect(value).not.toMatch(/execut|run|triage|import|source/)
    }
    await click('[data-backlog-action="capture"]')
    const dialog = await waitFor(() => q('[data-backlog-capture-dialog]')!)
    expect(unhandledControls(dialog)).toEqual([])
    expect(dialog.querySelectorAll(CONTROL_SELECTOR).length).toBeGreaterThanOrEqual(6)
  })

  type Scenario = {
    action: (typeof ACTION_ALLOW_LIST)[number]
    status?: string
    arrange?: () => void
    before?: () => Promise<void>
    effect: () => Promise<void>
  }

  const scenarios: Scenario[] = [
    {
      action: 'close',
      effect: async () => expect(mocks.closeBacklogPage).toHaveBeenCalledTimes(1)
    },
    {
      action: 'capture',
      effect: async () =>
        void (await waitFor(() => expect(q('[data-backlog-capture-dialog]')).not.toBeNull()))
    },
    {
      action: 'capture-empty',
      status: 'empty',
      arrange: () => {
        items = []
      },
      effect: async () =>
        void (await waitFor(() => expect(q('[data-backlog-capture-dialog]')).not.toBeNull()))
    },
    {
      action: 'retry',
      status: 'unreachable',
      arrange: () => {
        listFails = true
      },
      effect: async () => void (await waitFor(() => expect(calls('backlog.list')).toBe(2)))
    },
    {
      action: 'retry-summary',
      arrange: () => {
        healthFails = true
      },
      before: async () =>
        void (await waitFor(() =>
          expect(q('[data-backlog-action="retry-summary"]')).not.toBeNull()
        )),
      effect: async () => void (await waitFor(() => expect(calls('backlog.health')).toBe(2)))
    },
    {
      action: 'clear-filters',
      before: async () => {
        await userEvent.setup().type(q('[data-backlog-search]')!, 'zzz nothing')
        await waitFor(() => expect(status()).toBe('filter-empty'))
      },
      effect: async () => expect(status()).toBe('ready')
    },
    {
      action: 'show-all-states',
      status: 'filter-empty',
      arrange: () => {
        items = [item('x', { state: 'dismissed' })]
      },
      effect: async () => expect(status()).toBe('ready')
    },
    {
      action: 'copy-quarantine',
      arrange: () => {
        quarantined = [{ recordKind: 'item', fileName: 'x.json', id: 'x', code: 'parse' }]
      },
      before: async () =>
        void (await waitFor(() =>
          expect(q('[data-backlog-action="copy-quarantine"]')).not.toBeNull()
        )),
      // user-event installs its own clipboard; what the page wrote is readable from it.
      effect: async () =>
        void (await waitFor(async () =>
          expect(await navigator.clipboard.readText()).toContain('"fileName": "x.json"')
        ))
    },
    {
      action: 'reconcile',
      arrange: () => {
        listTotal = items.length + 1
      },
      effect: async () => void (await waitFor(() => expect(calls('backlog.list')).toBe(2)))
    },
    {
      action: 'change-state',
      before: async () => void (await expandRow('a')),
      effect: async () => void (await waitFor(() => expect(q('[role="menu"]')).not.toBeNull()))
    },
    {
      action: 'edit',
      before: async () => void (await expandRow('a')),
      effect: async () =>
        void (await waitFor(() => expect(q('[data-backlog-edit-form]')).not.toBeNull()))
    },
    {
      action: 'save-edit',
      before: async () => {
        await expandRow('a')
        await click('[data-backlog-action="edit"]')
        fireEvent.change(q('[data-backlog-edit-field="summary"]')!, {
          target: { value: 'renamed' }
        })
      },
      effect: async () => void (await waitFor(() => expect(calls('backlog.update')).toBe(1)))
    },
    {
      action: 'discard-edit',
      before: async () => {
        await expandRow('a')
        await click('[data-backlog-action="edit"]')
      },
      effect: async () => {
        expect(q('[data-backlog-edit-form]')).toBeNull()
        expect(calls('backlog.update')).toBe(0)
      }
    }
  ]

  it('drives every allow-listed action to its backlog call or its named local effect', async () => {
    expect(scenarios.map((scenario) => scenario.action).sort()).toEqual(
      [...ACTION_ALLOW_LIST].sort()
    )
  })

  for (const scenario of scenarios) {
    it(`${scenario.action} reaches its effect`, async () => {
      scenario.arrange?.()
      await renderPage(scenario.status ?? 'ready')
      await scenario.before?.()
      await click(`[data-backlog-action="${scenario.action}"]`)
      await scenario.effect()
    })
  }
})
