/** @vitest-environment happy-dom */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneSessionResumeResult } from '@/lib/pane-session-resume-intent'
import type * as TabSessionResumeTarget from '@/lib/tab-session-resume-target'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const holder = vi.hoisted(() => ({ targetKey: 'none' }))
const toastError = vi.hoisted(() => vi.fn())

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector({})
}))
vi.mock('@/lib/tab-session-resume-target', async (importOriginal) => ({
  ...(await importOriginal<typeof TabSessionResumeTarget>()),
  resolveTabSessionResumeTargetKey: () => holder.targetKey
}))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null
}))
vi.mock('sonner', () => ({ toast: { error: toastError } }))

const { TerminalTabSessionResumeButton } = await import('./TerminalTabSessionResumeButton')
const { registerPaneSessionResumeHandler } = await import('@/lib/pane-session-resume-dispatch')

const PANE_A = 'tab-1:11111111-1111-4111-8111-111111111111'
const PANE_B = 'tab-2:22222222-2222-4222-8222-222222222222'

let container: HTMLDivElement
let root: Root
let onActivate: ReturnType<typeof vi.fn<(tabId: string) => void>>
const releases: (() => void)[] = []

function render(): void {
  act(() => {
    root.render(
      <TerminalTabSessionResumeButton
        tab={{ id: 'tab-1', worktreeId: 'wt-1' }}
        isActive
        onActivate={onActivate}
      />
    )
  })
}

function button(): HTMLButtonElement | null {
  return container.querySelector('[data-testid="tab-session-resume-button"]')
}

async function click(): Promise<void> {
  await act(async () => {
    button()?.click()
  })
}

function mount(paneKey: string, handler: () => Promise<PaneSessionResumeResult>): void {
  act(() => {
    releases.push(registerPaneSessionResumeHandler(paneKey, handler))
  })
}

describe('TerminalTabSessionResumeButton', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    onActivate = vi.fn()
    toastError.mockClear()
    holder.targetKey = `one|${PANE_A}|available`
  })
  afterEach(() => {
    act(() => {
      releases.splice(0).forEach((release) => release())
      root.unmount()
    })
    container.remove()
  })

  it('is absent when the tab has no session to resume', () => {
    holder.targetKey = 'none'
    render()
    expect(container.innerHTML).toBe('')
  })

  it('resumes exactly the pane it names, once, however fast it is clicked', async () => {
    let finish!: (result: PaneSessionResumeResult) => void
    const own = vi.fn(
      () =>
        new Promise<PaneSessionResumeResult>((resolve) => {
          finish = resolve
        })
    )
    const other = vi.fn(async (): Promise<PaneSessionResumeResult> => ({ outcome: 'started' }))
    mount(PANE_A, own)
    mount(PANE_B, other)
    render()

    expect(button()?.getAttribute('aria-label')).toBe('Resume session')
    await click()
    await click()
    expect(own).toHaveBeenCalledTimes(1)
    expect(other).not.toHaveBeenCalled()
    expect(button()?.getAttribute('aria-busy')).toBe('true')

    await act(async () => finish({ outcome: 'started' }))
    expect(button()?.getAttribute('aria-busy')).toBe('false')
    expect(toastError).not.toHaveBeenCalled()
  })

  it('says why a resume did not start, in the strip’s own words', async () => {
    mount(PANE_A, async () => ({ outcome: 'blocked', reason: 'live-elsewhere' }))
    render()
    await click()
    expect(toastError).toHaveBeenCalledWith('This session is open in another pane.')
  })

  it('waits for the prompt instead of acting, and says so', async () => {
    holder.targetKey = `one|${PANE_A}|disabled|shell-unconfirmed`
    const own = vi.fn(async (): Promise<PaneSessionResumeResult> => ({ outcome: 'started' }))
    mount(PANE_A, own)
    render()
    expect(button()?.getAttribute('aria-disabled')).toBe('true')
    expect(button()?.getAttribute('aria-label')).toContain('back at its prompt')
    await click()
    expect(own).not.toHaveBeenCalled()
    expect(onActivate).not.toHaveBeenCalled()
  })

  it('opens the tab rather than guessing when the pane is not mounted or there are several', async () => {
    render()
    await click()
    expect(onActivate).toHaveBeenCalledWith('tab-1')

    holder.targetKey = 'several'
    const own = vi.fn(async (): Promise<PaneSessionResumeResult> => ({ outcome: 'started' }))
    mount(PANE_A, own)
    render()
    await click()
    expect(onActivate).toHaveBeenCalledTimes(2)
    expect(own).not.toHaveBeenCalled()
  })
})
