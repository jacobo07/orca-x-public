/** @vitest-environment happy-dom */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneSessionResumeCapability } from '@/lib/pane-session-resume-capability'
import type { PaneSessionResumeResult } from '@/lib/pane-session-resume-intent'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const holder = vi.hoisted(() => ({
  capability: { kind: 'hidden' } as PaneSessionResumeCapability
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector({})
}))
vi.mock('@/lib/pane-session-resume-capability', () => ({
  readPaneSessionResumeCapability: () => holder.capability
}))

const { PaneSessionResumeBanner } = await import('./PaneSessionResumeBanner')

const TARGET = { paneKey: 'tab-1:leaf-1', tabId: 'tab-1', worktreeId: 'wt-1' }

let container: HTMLDivElement
let root: Root

function render(onResume: () => Promise<PaneSessionResumeResult>): void {
  act(() => {
    root.render(<PaneSessionResumeBanner target={TARGET} onResume={onResume} />)
  })
}

function button(): HTMLButtonElement | null {
  return container.querySelector('[data-testid="pane-session-resume-button"]')
}

async function click(): Promise<void> {
  await act(async () => {
    button()?.click()
  })
}

describe('PaneSessionResumeBanner', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    holder.capability = { kind: 'available' }
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('renders nothing for a pane that has nothing to resume', () => {
    holder.capability = { kind: 'hidden' }
    render(vi.fn())

    expect(container.innerHTML).toBe('')
  })

  it('offers the action and never shows the session id', () => {
    render(vi.fn())

    expect(container.textContent).toContain('Session ended')
    expect(button()?.textContent).toBe('Resume this session')
    expect(button()?.disabled).toBe(false)
    expect(container.innerHTML).not.toContain('session-s')
  })

  it('asks for the resume once and shows progress while it runs', async () => {
    let finish!: (result: PaneSessionResumeResult) => void
    const onResume = vi.fn(
      () =>
        new Promise<PaneSessionResumeResult>((resolve) => {
          finish = resolve
        })
    )
    render(onResume)

    await click()
    expect(button()?.textContent).toBe('Resuming…')
    expect(button()?.disabled).toBe(true)
    await click()
    expect(onResume).toHaveBeenCalledTimes(1)

    await act(async () => finish({ outcome: 'cancelled' }))
    expect(button()?.disabled).toBe(false)
  })

  it('says why a resume did not happen', async () => {
    render(vi.fn(async () => ({ outcome: 'blocked', reason: 'live-elsewhere' }) as const))
    await click()
    expect(container.textContent).toContain('This session is open in another pane.')

    render(vi.fn(async () => ({ outcome: 'spawn-failed' }) as const))
    await click()
    expect(container.textContent).toContain("Couldn't resume this session. Try again.")
  })

  it('keeps the action disabled while the prompt is unproven', () => {
    holder.capability = { kind: 'disabled', reason: 'shell-unconfirmed' }
    render(vi.fn())

    expect(button()?.disabled).toBe(true)
    expect(button()?.title).toBe('Available when the shell is back at its prompt.')
  })

  it('explains an unavailable resume without offering it', () => {
    holder.capability = { kind: 'unavailable', reason: 'remote' }
    render(vi.fn())

    expect(button()).toBeNull()
    expect(container.textContent).toContain("Resume isn't available for remote terminals yet.")
  })
})
