// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BacklogMutationOutcome } from './backlog-mutation-client'

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  captureBacklogItem: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.state)
}))

vi.mock('./backlog-mutation-client', () => ({
  captureBacklogItem: mocks.captureBacklogItem
}))

import { BacklogCaptureDialog } from './BacklogCaptureDialog'

let container: HTMLDivElement
let root: Root
const onConfirmed = vi.fn()
const onUncertain = vi.fn()
const onOpenChange = vi.fn()

function render(): void {
  act(() => {
    root.render(
      <BacklogCaptureDialog
        open
        onOpenChange={onOpenChange}
        onConfirmed={onConfirmed}
        onUncertain={onUncertain}
      />
    )
  })
}

function q<T extends Element = HTMLElement>(selector: string): T | null {
  return document.body.querySelector<T>(selector)
}

function dialog(): HTMLElement {
  return q('[data-backlog-capture-dialog]')!
}

function field(): HTMLTextAreaElement {
  return q<HTMLTextAreaElement>('[data-backlog-capture-field="text"]')!
}

function submitButton(): HTMLButtonElement {
  return q<HTMLButtonElement>('[data-backlog-capture-submit]')!
}

function typeText(value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    setter.call(field(), value)
    field().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function submit(): Promise<void> {
  await act(async () => {
    submitButton().click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function chord(init: KeyboardEventInit): Promise<void> {
  await act(async () => {
    field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...init }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function choose(trigger: string, option: string): Promise<void> {
  const user = userEvent.setup()
  await user.click(q(trigger)!)
  await user.click(q(`[data-backlog-option="${option}"]`)!)
}

async function pickProject(value: string): Promise<void> {
  const user = userEvent.setup()
  await user.click(q('[data-backlog-capture-field="project"]')!)
  await user.click(q(`[data-backlog-capture-project-option="${value}"]`)!)
  await user.keyboard('{Escape}')
}

function projectValue(): string | null {
  return q('[data-backlog-capture-field="project"]')?.getAttribute('data-value') ?? null
}

beforeEach(() => {
  mocks.captureBacklogItem.mockReset()
  onConfirmed.mockReset()
  onUncertain.mockReset()
  onOpenChange.mockReset()
  mocks.state = {
    settings: { activeRuntimeEnvironmentId: null },
    activeRepoId: null,
    projects: [
      { id: 'P1', displayName: 'Project One', badgeColor: '#111111', sourceRepoIds: ['r1'] },
      { id: 'P2', displayName: 'Project Two', badgeColor: '#222222', sourceRepoIds: ['r2'] }
    ]
  }
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0)')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('BacklogCaptureDialog', () => {
  it('is idle with submit disabled while the text is blank', () => {
    render()
    expect(dialog().getAttribute('data-backlog-capture-status')).toBe('idle')
    expect(submitButton().disabled).toBe(true)
  })

  it('captures once with the defaults, disabled while in flight, then confirmed', async () => {
    let resolve: (outcome: BacklogMutationOutcome) => void = () => {}
    mocks.captureBacklogItem.mockReturnValue(
      new Promise<BacklogMutationOutcome>((r) => {
        resolve = r
      })
    )
    render()
    typeText('ship the backlog')
    await submit()
    expect(dialog().getAttribute('data-backlog-capture-status')).toBe('submitting')
    expect(submitButton().disabled).toBe(true)
    expect(mocks.captureBacklogItem).toHaveBeenCalledTimes(1)
    expect(mocks.captureBacklogItem.mock.calls[0][1]).toEqual({
      text: 'ship the backlog',
      kind: 'idea',
      priority: 'normal'
    })
    await act(async () => {
      resolve({ status: 'confirmed', item: {} as never, unchanged: false })
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(dialog().getAttribute('data-backlog-capture-status')).toBe('confirmed')
    expect(dialog().textContent).toContain('Captured to Unassigned')
    expect(onConfirmed).toHaveBeenCalledTimes(1)
    expect(onUncertain).not.toHaveBeenCalled()
  })

  const failures: BacklogMutationOutcome[] = [
    { status: 'storage-failed', stage: 'publish', code: null },
    { status: 'unknown' },
    { status: 'capability-unsupported' },
    { status: 'unreachable' }
  ]
  for (const outcome of failures) {
    it(`keeps the text and shows an alert on ${outcome.status}, never confirming or re-sending`, async () => {
      mocks.captureBacklogItem.mockResolvedValue(outcome)
      render()
      typeText('keep me')
      await submit()
      expect(dialog().getAttribute('data-backlog-capture-status')).toBe('failed')
      expect(dialog().getAttribute('data-backlog-capture-failure')).toBe(outcome.status)
      expect(field().value).toBe('keep me')
      expect(dialog().querySelector('[role="alert"]')).not.toBeNull()
      expect(onConfirmed).not.toHaveBeenCalled()
      await flush()
      expect(mocks.captureBacklogItem).toHaveBeenCalledTimes(1)
      expect(onUncertain).toHaveBeenCalledTimes(outcome.status === 'unknown' ? 1 : 0)
    })
  }
})

describe('capture fields', () => {
  it('defaults the project to the active repo project, else Unassigned; Idea, Normal, not ready', () => {
    mocks.state.activeRepoId = 'r1'
    render()
    expect(projectValue()).toBe('P1')
    expect(q('[data-backlog-capture-field="kind"]')?.getAttribute('data-value')).toBe('idea')
    expect(q('[data-backlog-capture-field="priority"]')?.getAttribute('data-value')).toBe('normal')
    expect(q('[data-backlog-capture-field="ready"]')?.getAttribute('aria-checked')).toBe('false')
    act(() => root.unmount())
    root = createRoot(container)
    mocks.state.activeRepoId = 'r-in-no-project'
    render()
    expect(projectValue()).toBe('unassigned')
    act(() => root.unmount())
    root = createRoot(container)
    mocks.state.activeRepoId = null
    render()
    expect(projectValue()).toBe('unassigned')
  })

  it('sends every chosen field once: explicit refs, kind, priority and initialState ready', async () => {
    mocks.state.activeRepoId = 'r1'
    mocks.captureBacklogItem.mockResolvedValue({
      status: 'confirmed',
      item: {} as never,
      unchanged: false
    })
    render()
    typeText('cross-project idea')
    await pickProject('P2')
    expect(projectValue()).toBe('P1,P2')
    await choose('[data-backlog-capture-field="kind"]', 'engineering')
    await choose('[data-backlog-capture-field="priority"]', 'high')
    await userEvent.setup().click(q('[data-backlog-capture-field="ready"]')!)
    await submit()
    expect(mocks.captureBacklogItem).toHaveBeenCalledTimes(1)
    expect(mocks.captureBacklogItem.mock.calls[0][1]).toEqual({
      text: 'cross-project idea',
      kind: 'engineering',
      priority: 'high',
      projectRefs: [
        { projectId: 'P1', mapping: 'explicit', evidence: '' },
        { projectId: 'P2', mapping: 'explicit', evidence: '' }
      ],
      initialState: 'ready'
    })
    expect(dialog().textContent).toContain('Captured to Project One, Project Two')
  })

  it('the counter appears at 18,000 characters; over 20,000 the text is invalid and submit is disabled', () => {
    render()
    typeText('x'.repeat(17_999))
    expect(q('[data-backlog-capture-counter]')).toBeNull()
    typeText('x'.repeat(18_000))
    expect(q('[data-backlog-capture-counter]')?.textContent).toBe('2,000 characters left')
    expect(field().getAttribute('aria-invalid')).not.toBe('true')
    typeText('x'.repeat(20_001))
    expect(field().getAttribute('aria-invalid')).toBe('true')
    expect(dialog().textContent).toContain('Text is over the 20,000-character limit')
    expect(submitButton().disabled).toBe(true)
  })

  it('Ctrl+Enter submits on Windows and Linux; Cmd+Enter does nothing there', async () => {
    mocks.captureBacklogItem.mockResolvedValue({ status: 'unknown' })
    render()
    expect(q('[data-backlog-capture-shortcut]')?.textContent).toContain('Ctrl')
    typeText('by chord')
    await chord({ metaKey: true })
    expect(mocks.captureBacklogItem).not.toHaveBeenCalled()
    await chord({ ctrlKey: true })
    expect(mocks.captureBacklogItem).toHaveBeenCalledTimes(1)
  })

  it('Cmd+Enter submits on a Mac; Ctrl+Enter does nothing there', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Mac OS X)')
    mocks.captureBacklogItem.mockResolvedValue({ status: 'unknown' })
    render()
    expect(q('[data-backlog-capture-shortcut]')?.textContent).toContain('⌘')
    typeText('by chord')
    await chord({ ctrlKey: true })
    expect(mocks.captureBacklogItem).not.toHaveBeenCalled()
    await chord({ metaKey: true })
    expect(mocks.captureBacklogItem).toHaveBeenCalledTimes(1)
  })

  it('Capture another item clears the text, keeps project, kind and priority, and refocuses Text', async () => {
    mocks.state.activeRepoId = 'r1'
    mocks.captureBacklogItem.mockResolvedValue({
      status: 'confirmed',
      item: {} as never,
      unchanged: false
    })
    render()
    typeText('first')
    await choose('[data-backlog-capture-field="priority"]', 'urgent')
    await submit()
    expect(dialog().textContent).toContain('Captured to Project One')
    await userEvent.setup().click(q('[data-backlog-capture-another]')!)
    expect(dialog().getAttribute('data-backlog-capture-status')).toBe('idle')
    expect(field().value).toBe('')
    expect(document.activeElement).toBe(field())
    expect(projectValue()).toBe('P1')
    expect(q('[data-backlog-capture-field="priority"]')?.getAttribute('data-value')).toBe('urgent')
    await userEvent.setup().click(q('[data-backlog-capture-close]')!)
    expect(onOpenChange).toHaveBeenLastCalledWith(false)
  })
})
