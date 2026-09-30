// @vitest-environment happy-dom

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BacklogItem } from '../../../../shared/backlog-types'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'

const mocks = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.state)
}))

import { BacklogRowDetail } from './BacklogRowDetail'

const runtimeCall = vi.fn()
const onLedgerChanged = vi.fn()
let record: BacklogItem
let updateAnswer: ((patch: Record<string, unknown>) => Promise<unknown>) | null = null

function item(overrides: Partial<BacklogItem> = {}): BacklogItem {
  return {
    schemaVersion: 1,
    id: 'a',
    kind: 'idea',
    originalText: 'the words as typed',
    normalizedIntent: 'tidy summary',
    projectRefs: [{ projectId: 'P1', mapping: 'inferred', evidence: 'hint' }],
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

function calls(method: string): Record<string, unknown>[] {
  return runtimeCall.mock.calls
    .filter(([args]) => args.method === method)
    .map(([args]) => args.params as Record<string, unknown>)
}

function confirmUpdate(patch: Record<string, unknown>): Promise<unknown> {
  record = { ...record, ...patch, revision: record.revision + 1 } as BacklogItem
  return Promise.resolve(envelope({ outcome: 'published', record }))
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  runtimeCall.mockReset()
  onLedgerChanged.mockReset()
  updateAnswer = null
  record = item()
  runtimeCall.mockImplementation(
    async ({ method, params }: { method: string; params: Record<string, unknown> }) => {
      if (method === 'backlog.get') {
        return envelope({ outcome: 'loaded', record })
      }
      if (method === 'backlog.update') {
        const patch = params.patch as Record<string, unknown>
        return (updateAnswer ?? confirmUpdate)(patch)
      }
      throw new Error(`unexpected ${method}`)
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
    ]
  }
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0)')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function q<T extends Element = HTMLElement>(selector: string): T | null {
  return document.body.querySelector<T>(selector)
}

function saveButton(): HTMLButtonElement {
  return q<HTMLButtonElement>('[data-backlog-action="save-edit"]')!
}

function summaryField(): HTMLTextAreaElement {
  return q<HTMLTextAreaElement>('[data-backlog-edit-field="summary"]')!
}

async function openEditor(): Promise<void> {
  render(
    <BacklogRowDetail
      id="detail"
      itemId="a"
      title="tidy summary"
      groupKey="project:P1"
      onLedgerChanged={onLedgerChanged}
    />
  )
  await waitFor(() =>
    expect(q('[data-backlog-item-detail]')?.getAttribute('data-backlog-detail-status')).toBe(
      'loaded'
    )
  )
  await userEvent.setup().click(q('[data-backlog-action="edit"]')!)
  await waitFor(() => expect(q('[data-backlog-edit-form]')).not.toBeNull())
}

async function choose(trigger: string, option: string): Promise<void> {
  const user = userEvent.setup()
  await user.click(q(trigger)!)
  await user.click(q(`[data-backlog-option="${option}"]`)!)
}

async function openPicker(): Promise<void> {
  await userEvent.setup().click(q('[data-backlog-edit-field="project"]')!)
  await waitFor(() => expect(q('[data-backlog-capture-project-option]')).not.toBeNull())
}

function pickerOptions(): string[] {
  return Array.from(document.querySelectorAll('[data-backlog-capture-project-option]')).map(
    (option) => option.getAttribute('data-backlog-capture-project-option') ?? ''
  )
}

async function pick(value: string): Promise<void> {
  await userEvent.setup().click(q(`[data-backlog-capture-project-option="${value}"]`)!)
}

function setSummary(value: string): void {
  fireEvent.change(summaryField(), { target: { value } })
}

describe('BacklogRowEditForm', () => {
  it('Edit item swaps the detail for a prefilled form; the original text stays read-only', async () => {
    await openEditor()
    expect(q('[data-backlog-detail-text]')).toBeNull()
    expect(summaryField().value).toBe('tidy summary')
    expect(summaryField().getAttribute('aria-label')).toBe('Summary')
    const original = q('[data-backlog-edit-original]')!
    expect(original.textContent).toBe('the words as typed')
    expect(original.querySelector('input, textarea')).toBeNull()
    expect(q('[data-backlog-edit-field="kind"]')?.getAttribute('data-value')).toBe('idea')
    expect(q('[data-backlog-edit-field="priority"]')?.getAttribute('data-value')).toBe('normal')
    expect(q('[data-backlog-edit-field="project"]')?.getAttribute('data-value')).toBe('P1')
    expect(saveButton().disabled).toBe(true)
  })

  it('sends only the changed key once; confirmed closes the form and asks the page to refetch', async () => {
    await openEditor()
    await choose('[data-backlog-edit-field="priority"]', 'high')
    expect(saveButton().disabled).toBe(false)
    await userEvent.setup().click(saveButton())
    await waitFor(() => expect(q('[data-backlog-edit-form]')).toBeNull())
    expect(calls('backlog.update')).toEqual([{ id: 'a', patch: { priority: 'high' } }])
    const sent = calls('backlog.update')[0].patch as Record<string, unknown>
    expect(sent).not.toHaveProperty('originalText')
    expect(sent).not.toHaveProperty('projectRefs')
    expect(q('[data-backlog-item-detail]')?.textContent).toContain('High')
    expect(onLedgerChanged).toHaveBeenCalledWith({
      itemId: 'a',
      groupKey: 'project:P1',
      movedTo: null
    })
  })

  it('Discard changes and Esc restore the detail without a call; Ctrl+Enter saves', async () => {
    await openEditor()
    setSummary('changed text')
    await userEvent.setup().click(q('[data-backlog-action="discard-edit"]')!)
    expect(q('[data-backlog-edit-form]')).toBeNull()
    expect(q('[data-backlog-detail-text]')).not.toBeNull()
    await userEvent.setup().click(q('[data-backlog-action="edit"]')!)
    setSummary('changed again')
    fireEvent.keyDown(summaryField(), { key: 'Escape' })
    expect(q('[data-backlog-edit-form]')).toBeNull()
    expect(calls('backlog.update')).toHaveLength(0)
    await userEvent.setup().click(q('[data-backlog-action="edit"]')!)
    setSummary('saved by chord')
    fireEvent.keyDown(summaryField(), { key: 'Enter', metaKey: true })
    expect(calls('backlog.update')).toHaveLength(0)
    fireEvent.keyDown(summaryField(), { key: 'Enter', ctrlKey: true })
    await waitFor(() =>
      expect(calls('backlog.update')).toEqual([
        { id: 'a', patch: { normalizedIntent: 'saved by chord' } }
      ])
    )
  })

  it('on a Mac, Cmd+Enter saves and Ctrl+Enter does not', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Mac OS X)')
    await openEditor()
    setSummary('mac chord')
    fireEvent.keyDown(summaryField(), { key: 'Enter', ctrlKey: true })
    expect(calls('backlog.update')).toHaveLength(0)
    fireEvent.keyDown(summaryField(), { key: 'Enter', metaKey: true })
    await waitFor(() => expect(calls('backlog.update')).toHaveLength(1))
  })

  it('the summary counter appears within 10% of 2,000 and over the limit the field is invalid', async () => {
    await openEditor()
    setSummary('x'.repeat(1799))
    expect(q('[data-backlog-edit-counter]')).toBeNull()
    setSummary('x'.repeat(1800))
    expect(q('[data-backlog-edit-counter]')?.textContent).toBe('200 characters left')
    setSummary('x'.repeat(2001))
    expect(summaryField().getAttribute('aria-invalid')).toBe('true')
    expect(saveButton().disabled).toBe(true)
    setSummary('   ')
    expect(saveButton().disabled).toBe(true)
  })
})

describe('BacklogProjectPicker in the edit form', () => {
  it('offers pinned Unassigned then the store projects; Unassigned and projects are exclusive', async () => {
    await openEditor()
    await openPicker()
    expect(pickerOptions()).toEqual(['unassigned', 'P1', 'P2'])
    expect(q('[data-backlog-capture-project-option="P1"]')?.getAttribute('data-selected')).toBe(
      'true'
    )
    await pick('unassigned')
    expect(q('[data-backlog-edit-field="project"]')?.getAttribute('data-value')).toBe('unassigned')
    expect(q('[data-backlog-capture-project-option="P1"]')?.getAttribute('data-selected')).toBe(
      'false'
    )
    await pick('P2')
    expect(q('[data-backlog-edit-field="project"]')?.getAttribute('data-value')).toBe('P2')
    expect(
      q('[data-backlog-capture-project-option="unassigned"]')?.getAttribute('data-selected')
    ).toBe('false')
  })

  it('a kept ref keeps its mapping and evidence; an added ref is explicit with empty evidence', async () => {
    await openEditor()
    await openPicker()
    await pick('P2')
    await userEvent.setup().click(saveButton())
    await waitFor(() => expect(calls('backlog.update')).toHaveLength(1))
    expect(calls('backlog.update')[0].patch).toEqual({
      projectRefs: [
        { projectId: 'P1', mapping: 'inferred', evidence: 'hint' },
        { projectId: 'P2', mapping: 'explicit', evidence: '' }
      ]
    })
  })

  it('typing an unknown name offers no create option and no other project', async () => {
    await openEditor()
    await openPicker()
    await userEvent.setup().type(q('[data-backlog-project-search]')!, 'Brand New Project')
    for (const value of pickerOptions()) {
      expect(['unassigned', 'P1', 'P2']).toContain(value)
    }
    expect(document.body.textContent).not.toContain('Create')
  })
})

describe('edit outcomes', () => {
  it('stale reloads the record and says so', async () => {
    updateAnswer = async () => envelope({ outcome: 'superseded' })
    await openEditor()
    setSummary('stale edit')
    await userEvent.setup().click(saveButton())
    await waitFor(() =>
      expect(q('[data-backlog-item-detail]')?.textContent).toContain(
        'This item changed since it was loaded. It has been reloaded; try again.'
      )
    )
    expect(q('[data-backlog-edit-form]')).toBeNull()
    expect(calls('backlog.get')).toHaveLength(2)
  })

  it('unknown reloads, says it could not be confirmed, and asks for a refetch', async () => {
    updateAnswer = async () => {
      throw new Error('reply lost')
    }
    await openEditor()
    setSummary('maybe saved')
    await userEvent.setup().click(saveButton())
    await waitFor(() =>
      expect(q('[data-backlog-item-detail]')?.textContent).toContain(
        'We could not confirm this change was saved. The item has been reloaded.'
      )
    )
    expect(calls('backlog.get')).toHaveLength(2)
    expect(calls('backlog.update')).toHaveLength(1)
    expect(onLedgerChanged).toHaveBeenCalledTimes(1)
  })

  const kept: [string, unknown, string][] = [
    [
      'kind-change-while-done',
      envelope({ outcome: 'refused', code: 'kind-change-while-done' }),
      'The kind cannot change while the item is done.'
    ],
    [
      'item-capacity-exceeded',
      envelope({ outcome: 'refused', code: 'item-capacity-exceeded' }),
      'This item has reached its size limit.'
    ],
    [
      'storage-failed',
      envelope({ outcome: 'storage-failed', stage: 'write', code: null }),
      'Not changed. The ledger could not write this change. Try again.'
    ]
  ]
  for (const [name, answer, copy] of kept) {
    it(`${name} keeps the form and the user's edits`, async () => {
      updateAnswer = async () => answer
      await openEditor()
      setSummary('my careful edit')
      await userEvent.setup().click(saveButton())
      await waitFor(() =>
        expect(q('[data-backlog-edit-form] [role="alert"]')?.textContent).toBe(copy)
      )
      expect(summaryField().value).toBe('my careful edit')
      expect(calls('backlog.get')).toHaveLength(1)
      expect(onLedgerChanged).not.toHaveBeenCalled()
    })
  }
})
