// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BacklogMutationOutcome } from './backlog-mutation-client'

const mocks = vi.hoisted(() => ({
  state: { settings: { activeRuntimeEnvironmentId: null } } as Record<string, unknown>,
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

function render(): void {
  act(() => {
    root.render(
      <BacklogCaptureDialog
        open
        onOpenChange={() => {}}
        onConfirmed={onConfirmed}
        onUncertain={onUncertain}
      />
    )
  })
}

function dialog(): HTMLElement {
  return document.body.querySelector<HTMLElement>('[data-backlog-capture-dialog]')!
}

function field(): HTMLTextAreaElement {
  return document.body.querySelector<HTMLTextAreaElement>('[data-backlog-capture-field="text"]')!
}

function submitButton(): HTMLButtonElement {
  return document.body.querySelector<HTMLButtonElement>('[data-backlog-capture-submit]')!
}

function typeText(value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    setter.call(field(), value)
    field().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function submit(): Promise<void> {
  await act(async () => {
    submitButton().click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  mocks.captureBacklogItem.mockReset()
  onConfirmed.mockReset()
  onUncertain.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('BacklogCaptureDialog', () => {
  it('is idle with submit disabled while the text is blank', () => {
    render()
    expect(dialog().getAttribute('data-backlog-capture-status')).toBe('idle')
    expect(submitButton().disabled).toBe(true)
  })

  it('captures once as an Unassigned idea, disabled while in flight, then confirmed', async () => {
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
      kind: 'idea'
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
    it(`keeps the text and shows an alert on ${outcome.status}, never confirming`, async () => {
      mocks.captureBacklogItem.mockResolvedValue(outcome)
      render()
      typeText('keep me')
      await submit()
      expect(dialog().getAttribute('data-backlog-capture-status')).toBe('failed')
      expect(dialog().getAttribute('data-backlog-capture-failure')).toBe(outcome.status)
      expect(field().value).toBe('keep me')
      expect(dialog().querySelector('[role="alert"]')).not.toBeNull()
      expect(onConfirmed).not.toHaveBeenCalled()
      expect(mocks.captureBacklogItem).toHaveBeenCalledTimes(1)
      expect(onUncertain).toHaveBeenCalledTimes(outcome.status === 'unknown' ? 1 : 0)
    })
  }
})
