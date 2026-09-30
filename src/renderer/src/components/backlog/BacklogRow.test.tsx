// @vitest-environment happy-dom

import { act, cleanup, render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { BACKLOG_TRANSITIONS } from '../../../../shared/backlog-lifecycle'
import {
  BACKLOG_ITEM_STATES,
  type BacklogEvidence,
  type BacklogItem,
  type BacklogItemState,
  type BacklogProjectRef
} from '../../../../shared/backlog-types'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'

const mocks = vi.hoisted(() => ({ state: {} as Record<string, unknown>, toast: vi.fn() }))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.state)
}))

vi.mock('sonner', () => ({ toast: mocks.toast }))

import BacklogPage from './BacklogPage'
import { BacklogStateMenu } from './BacklogStateMenu'

const runtimeCall = vi.fn()
let ledger = new Map<string, BacklogItem>()
let getAnswer: ((id: string) => unknown) | null = null
let transitionAnswer: ((id: string, to: BacklogItemState) => Promise<unknown>) | null = null
let listGate: Promise<void> | null = null

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

function ref(projectId: string, mapping: BacklogProjectRef['mapping'] = 'explicit') {
  return { projectId, mapping, evidence: 'test' }
}

function envelope(result: Record<string, unknown>) {
  return { id: 'r', ok: true, result, _meta: { runtimeId: 'local' } }
}

function calls(method: string): Record<string, unknown>[] {
  return runtimeCall.mock.calls
    .filter(([args]) => args.method === method)
    .map(([args]) => args.params as Record<string, unknown>)
}

function confirmTransition(id: string, to: BacklogItemState): Promise<unknown> {
  const next = { ...ledger.get(id)!, state: to, revision: 2 }
  ledger.set(id, next)
  return Promise.resolve(envelope({ outcome: 'published', record: next }))
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  runtimeCall.mockReset()
  mocks.toast.mockReset()
  getAnswer = null
  transitionAnswer = null
  listGate = null
  ledger = new Map(
    [
      item('a', { projectRefs: [ref('P1')], updatedAt: 60 }),
      item('b', { projectRefs: [ref('P1')], updatedAt: 50 }),
      item('c', { projectRefs: [ref('P1'), ref('P2')], updatedAt: 40 }),
      item('d', { updatedAt: 30 })
    ].map((row) => [row.id, row])
  )
  runtimeCall.mockImplementation(
    async ({ method, params }: { method: string; params: Record<string, unknown> }) => {
      if (method === 'backlog.health') {
        return envelope({
          outcome: 'opened',
          items: { total: 0, byState: {} },
          candidates: { total: 0, byStatus: {} },
          quarantined: []
        })
      }
      if (method === 'backlog.get') {
        const id = String(params.id)
        if (getAnswer) {
          return getAnswer(id)
        }
        const found = ledger.get(id)
        return envelope(found ? { outcome: 'loaded', record: found } : { outcome: 'absent' })
      }
      if (method === 'backlog.transition') {
        const answer = transitionAnswer ?? confirmTransition
        return answer(String(params.id), params.to as BacklogItemState)
      }
      if (listGate) {
        await listGate
      }
      const items = Array.from(ledger.values())
      return envelope({
        outcome: 'listed',
        view: 'summary',
        items,
        total: items.length,
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
    projects: [
      { id: 'P1', displayName: 'Project One', badgeColor: '#111111', sourceRepoIds: [] },
      { id: 'P2', displayName: 'Project Two', badgeColor: '#222222', sourceRepoIds: [] }
    ],
    closeBacklogPage: vi.fn()
  }
})

afterEach(cleanup)

function q<T extends Element = HTMLElement>(selector: string, scope: ParentNode = document) {
  return scope.querySelector<T>(selector)
}

function rowIn(groupKey: string, id: string): HTMLElement | null {
  return q(`[data-backlog-group="${groupKey}"] [data-backlog-item-id="${id}"]`)
}

function toggleIn(groupKey: string, id: string): HTMLButtonElement {
  return rowIn(groupKey, id)!.querySelector<HTMLButtonElement>('[data-backlog-row-toggle]')!
}

async function renderPage(): Promise<void> {
  render(
    <TooltipProvider>
      <BacklogPage />
    </TooltipProvider>
  )
  await waitFor(() =>
    expect(q('[data-backlog-page]')?.getAttribute('data-backlog-status')).toBe('ready')
  )
}

async function expand(groupKey: string, id: string): Promise<HTMLElement> {
  await userEvent.setup().click(toggleIn(groupKey, id))
  await waitFor(() =>
    expect(
      rowIn(groupKey, id)
        ?.querySelector('[data-backlog-item-detail]')
        ?.getAttribute('data-backlog-detail-status')
    ).not.toBe('loading')
  )
  return rowIn(groupKey, id)!.querySelector<HTMLElement>('[data-backlog-item-detail]')!
}

async function openMenu(scope: ParentNode): Promise<HTMLElement[]> {
  await userEvent.setup().click(q('[data-backlog-action="change-state"]', scope)!)
  await waitFor(() => expect(q('[role="menu"]')).not.toBeNull())
  return Array.from(document.querySelectorAll<HTMLElement>('[data-backlog-transition]'))
}

function transitionsShown(menuItems: HTMLElement[]): string[] {
  return menuItems.map((entry) => entry.getAttribute('data-backlog-transition') ?? '')
}

describe('BacklogRow expand and detail', () => {
  it('the row header is one toggle that expands on click, Enter and Space, reading backlog.get once per expand', async () => {
    await renderPage()
    const toggle = toggleIn('project:P1', 'a')
    expect(toggle.tagName).toBe('BUTTON')
    expect(toggle.getAttribute('type')).toBe('button')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    const detail = await expand('project:P1', 'a')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(rowIn('project:P1', 'a')?.getAttribute('data-expanded')).toBe('true')
    expect(detail.id).toBe(toggle.getAttribute('aria-controls'))
    expect(detail.getAttribute('role')).toBe('region')
    expect(detail.getAttribute('aria-label')).toBe('text of a')
    expect(calls('backlog.get')).toEqual([{ id: 'a' }])
    const user = userEvent.setup()
    toggle.focus()
    await user.keyboard('{Enter}')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(rowIn('project:P1', 'a')?.querySelector('[data-backlog-item-detail]')).toBeNull()
    await user.keyboard(' ')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    await waitFor(() => expect(calls('backlog.get')).toHaveLength(2))
  })

  it('two rendered instances of a cross-project row control different detail ids', async () => {
    await renderPage()
    const inP1 = toggleIn('project:P1', 'c').getAttribute('aria-controls')
    const inP2 = toggleIn('project:P2', 'c').getAttribute('aria-controls')
    expect(inP1).toBeTruthy()
    expect(inP2).toBeTruthy()
    expect(inP1).not.toBe(inP2)
  })

  it('shows the full record: text, summary, fields, projects, sources and history newest first, no raw payload', async () => {
    const text = 'first line\n\n    indented second line\nthird'
    ledger.set(
      'a',
      item('a', {
        originalText: text,
        normalizedIntent: 'tidy summary',
        projectRefs: [ref('P1'), ref('P9', 'inferred')],
        sourceLinks: [{ kind: 'manual', ref: 'm1', capturedAt: 5, candidateId: null }],
        events: [
          { id: 'e1', type: 'created', at: 1, data: { payload: 'RAW-PAYLOAD-SENTINEL' } },
          { id: 'e3', type: 'transitioned', at: 3, data: { from: 'x' } },
          { id: 'e2', type: 'updated', at: 2, data: {} }
        ],
        updatedAt: 60
      })
    )
    await renderPage()
    const detail = await expand('project:P1', 'a')
    const scroller = q<HTMLElement>('[data-backlog-detail-text]', detail)!
    expect(scroller.textContent).toBe(text)
    expect(scroller.tabIndex).toBe(0)
    expect(scroller.getAttribute('aria-label')).toBe('Item text')
    expect(q('[data-backlog-detail-summary]', detail)?.textContent).toContain('tidy summary')
    const fields = Array.from(detail.querySelectorAll('dt')).map((dt) => dt.textContent)
    expect(fields).toEqual(['Kind', 'Priority', 'State', 'Created', 'Updated'])
    const projects = Array.from(detail.querySelectorAll('[data-backlog-detail-project]'))
    expect(projects.map((entry) => entry.getAttribute('data-backlog-detail-project'))).toEqual([
      'P1',
      'P9'
    ])
    expect(projects[0].textContent).toContain('Project One')
    expect(projects[0].textContent).toContain('Explicit')
    expect(projects[1].textContent).toContain('Unknown project')
    expect(projects[1].textContent).toContain('P9')
    expect(projects[1].textContent).toContain('Inferred')
    expect(q('[data-backlog-detail-source]', detail)?.textContent).toContain('Manual')
    const history = Array.from(detail.querySelectorAll('[data-backlog-event]'))
    expect(history.map((entry) => entry.getAttribute('data-backlog-event'))).toEqual([
      'transitioned',
      'updated',
      'created'
    ])
    expect(history[0].textContent).toContain('State changed')
    expect(detail.textContent).not.toContain('RAW-PAYLOAD-SENTINEL')
  })

  const getFailures: [string, unknown][] = [
    ['absent', envelope({ outcome: 'absent' })],
    ['unreadable', envelope({ outcome: 'unreadable', code: 'not-json' })],
    ['schema-too-new', envelope({ outcome: 'schema-too-new', storedVersion: 9 })],
    ['storage-failed', envelope({ outcome: 'storage-failed', stage: 'scan', code: 'EIO' })]
  ]
  for (const [status, answer] of getFailures) {
    it(`a ${status} read renders its own short state inside the detail, never an empty one`, async () => {
      getAnswer = () => answer
      await renderPage()
      const detail = await expand('project:P1', 'a')
      expect(detail.getAttribute('data-backlog-detail-status')).toBe(status)
      expect(detail.textContent?.trim()).not.toBe('')
      expect(q('[data-backlog-action="change-state"]', detail)).toBeNull()
    })
  }
})

describe('BacklogStateMenu', () => {
  it('lists exactly the legal targets for every state, never superseded', async () => {
    for (const state of BACKLOG_ITEM_STATES) {
      const legal = BACKLOG_TRANSITIONS[state].filter((to) => to !== 'superseded')
      const view = render(<BacklogStateMenu item={item('m', { state })} onOutcome={() => {}} />)
      if (legal.length === 0) {
        expect(q<HTMLButtonElement>('[data-backlog-action="change-state"]')?.disabled).toBe(true)
        view.unmount()
        continue
      }
      const shown = transitionsShown(await openMenu(document))
      expect(shown).toEqual(legal)
      expect(shown).not.toContain('superseded')
      view.unmount()
      cleanup()
    }
  })

  it('needs-triage offers ready, blocked, dismissed, unknown, stale; done offers ready', async () => {
    let view = render(<BacklogStateMenu item={item('m')} onOutcome={() => {}} />)
    expect(transitionsShown(await openMenu(document))).toEqual([
      'ready',
      'blocked',
      'dismissed',
      'unknown',
      'stale'
    ])
    view.unmount()
    cleanup()
    view = render(
      <BacklogStateMenu item={item('m', { state: 'done', kind: 'manual' })} onOutcome={() => {}} />
    )
    expect(transitionsShown(await openMenu(document))).toEqual(['ready'])
  })

  it('done without evidence is present, disabled and says why; with evidence it is enabled', async () => {
    let view = render(
      <BacklogStateMenu
        item={item('m', { state: 'ready', kind: 'engineering' })}
        onOutcome={() => {}}
      />
    )
    await openMenu(document)
    let done = q('[data-backlog-transition="done"]')!
    expect(done.hasAttribute('data-disabled')).toBe(true)
    expect(done.getAttribute('data-disabled-reason')).toBe('completion-evidence-missing')
    expect(done.textContent).toContain('Needs completion evidence first')
    view.unmount()
    cleanup()

    view = render(
      <BacklogStateMenu item={item('m', { state: 'ready', kind: 'idea' })} onOutcome={() => {}} />
    )
    await openMenu(document)
    done = q('[data-backlog-transition="done"]')!
    expect(done.getAttribute('data-disabled-reason')).toBe('idea-cannot-complete')
    expect(done.textContent).toContain('An idea cannot be marked done; change its kind first')
    view.unmount()
    cleanup()

    view = render(<BacklogStateMenu item={item('m', { kind: 'idea' })} onOutcome={() => {}} />)
    await openMenu(document)
    expect(q('[data-backlog-transition="done"]')).toBeNull()
    view.unmount()
    cleanup()

    const proven = (subject: BacklogEvidence['subject']): BacklogEvidence => ({
      id: subject,
      class: 'PROVEN',
      origin: 'tool',
      subject,
      source: 'test',
      ref: null,
      observedAt: 1
    })
    render(
      <BacklogStateMenu
        item={item('m', {
          state: 'ready',
          kind: 'engineering',
          evidence: [proven('revision'), proven('gate')]
        })}
        onOutcome={() => {}}
      />
    )
    await openMenu(document)
    done = q('[data-backlog-transition="done"]')!
    expect(done.hasAttribute('data-disabled')).toBe(false)
    expect(done.hasAttribute('data-disabled-reason')).toBe(false)
  })
})

describe('changing state through the ledger', () => {
  it('dismissed: one transition, the row leaves the Open view only after the refetch, and focus moves to the next row', async () => {
    await renderPage()
    const detail = await expand('project:P1', 'a')
    const listsBefore = calls('backlog.list').length
    let release: () => void = () => {}
    listGate = new Promise<void>((resolve) => {
      release = resolve
    })
    await openMenu(detail)
    await userEvent.setup().click(q('[data-backlog-transition="dismissed"]')!)
    await waitFor(() => expect(calls('backlog.transition')).toEqual([{ id: 'a', to: 'dismissed' }]))
    await waitFor(() => expect(calls('backlog.list').length).toBe(listsBefore + 1))
    // Confirmed, but the refetch has not answered: the row has not moved yet.
    expect(rowIn('project:P1', 'a')).not.toBeNull()
    expect(mocks.toast).toHaveBeenCalledWith('Moved to Dismissed')
    expect(q('[data-backlog-moved-region]')?.getAttribute('aria-live')).toBe('polite')
    expect(q('[data-backlog-moved-region]')?.textContent).toBe('Moved to Dismissed')
    await act(async () => {
      release()
      listGate = null
    })
    await waitFor(() => expect(rowIn('project:P1', 'a')).toBeNull())
    expect(calls('backlog.list').length).toBe(listsBefore + 1)
    expect(calls('backlog.transition')).toHaveLength(1)
    await waitFor(() => expect(document.activeElement).toBe(toggleIn('project:P1', 'b')))
  })

  it('when no row follows in the group, focus moves to the group toggle', async () => {
    ledger = new Map([['z', item('z', { projectRefs: [ref('P2')], updatedAt: 5 })]])
    ledger.set('y', item('y', { projectRefs: [ref('P2')], updatedAt: 9 }))
    await renderPage()
    const detail = await expand('project:P2', 'z')
    await openMenu(detail)
    await userEvent.setup().click(q('[data-backlog-transition="dismissed"]')!)
    await waitFor(() => expect(rowIn('project:P2', 'z')).toBeNull())
    await waitFor(() =>
      expect(document.activeElement).toBe(
        q('[data-backlog-group="project:P2"] [data-backlog-group-toggle]')
      )
    )
  })

  it('stale: the detail reloads and says so; nothing is refetched or moved', async () => {
    transitionAnswer = async () => envelope({ outcome: 'superseded' })
    await renderPage()
    const detail = await expand('project:P1', 'a')
    const listsBefore = calls('backlog.list').length
    await openMenu(detail)
    await userEvent.setup().click(q('[data-backlog-transition="ready"]')!)
    await waitFor(() =>
      expect(q('[data-backlog-item-detail]')?.textContent).toContain(
        'This item changed since it was loaded. It has been reloaded; try again.'
      )
    )
    expect(calls('backlog.get')).toHaveLength(2)
    expect(calls('backlog.list').length).toBe(listsBefore)
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  const failures: [string, () => Promise<unknown>][] = [
    ['refused', async () => envelope({ outcome: 'refused', code: 'illegal-transition' })],
    [
      'storage-failed',
      async () => envelope({ outcome: 'storage-failed', stage: 'write', code: null })
    ]
  ]
  for (const [name, answer] of failures) {
    it(`${name}: the error copy shows as an alert and nothing moves`, async () => {
      transitionAnswer = answer
      await renderPage()
      const detail = await expand('project:P1', 'a')
      const listsBefore = calls('backlog.list').length
      await openMenu(detail)
      await userEvent.setup().click(q('[data-backlog-transition="dismissed"]')!)
      await waitFor(() =>
        expect(q('[data-backlog-item-detail] [role="alert"]')?.textContent).toBe(
          'Not changed. The ledger could not write this change. Try again.'
        )
      )
      expect(rowIn('project:P1', 'a')?.getAttribute('data-backlog-state')).toBe('needs-triage')
      expect(calls('backlog.list').length).toBe(listsBefore)
      expect(calls('backlog.transition')).toHaveLength(1)
      expect(mocks.toast).not.toHaveBeenCalled()
    })
  }

  it('unknown: the item reloads, the page refetches once, and the change is never re-sent', async () => {
    transitionAnswer = async () => {
      throw new Error('reply lost')
    }
    await renderPage()
    const detail = await expand('project:P1', 'a')
    const listsBefore = calls('backlog.list').length
    await openMenu(detail)
    await userEvent.setup().click(q('[data-backlog-transition="dismissed"]')!)
    await waitFor(() =>
      expect(q('[data-backlog-item-detail]')?.textContent).toContain(
        'We could not confirm this change. The item has been reloaded.'
      )
    )
    await waitFor(() => expect(calls('backlog.list').length).toBe(listsBefore + 1))
    expect(calls('backlog.get')).toHaveLength(2)
    expect(calls('backlog.transition')).toHaveLength(1)
    expect(mocks.toast).not.toHaveBeenCalled()
  })
})
