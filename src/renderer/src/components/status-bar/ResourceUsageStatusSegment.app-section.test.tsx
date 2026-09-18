// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AppMemory,
  ProcessSweepOutcome,
  UsageValues
} from '../../../../shared/process-stats-types'

vi.mock('@/store', () => {
  const storeState = {}
  const useAppStore = Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    { getState: () => storeState }
  )
  return { useAppStore }
})

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { AppSection } from './ResourceUsageStatusSegment'

const zero = { cpu: 0, memory: 0 }

function makeApp(terminalHost?: UsageValues): AppMemory {
  return {
    cpu: 1,
    memory: 100,
    main: { cpu: 1, memory: 100 },
    renderer: zero,
    other: zero,
    ...(terminalHost ? { terminalHost } : {}),
    history: []
  }
}

describe('AppSection terminal host rows', () => {
  let container: HTMLDivElement
  let root: Root

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function render(props: {
    app: AppMemory
    terminalHostDescendants?: UsageValues
    processSweep?: ProcessSweepOutcome
  }): string {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root.render(<AppSection {...props} isCollapsed={false} onToggle={() => {}} />)
    })
    return container.textContent ?? ''
  }

  it('shows the terminal host inside Orca and unattributed processes outside it', () => {
    const text = render({
      app: makeApp({ cpu: 2, memory: 40 * 1024 * 1024 }),
      terminalHostDescendants: { cpu: 0, memory: 8 * 1024 * 1024 },
      processSweep: 'measured'
    })
    expect(text).toContain('Terminal host')
    expect(text).toContain('Unattributed terminal processes')
    expect(text).not.toContain('unknown, not zero')
  })

  it('hides both rows for an older host that sends neither field', () => {
    const text = render({ app: makeApp() })
    expect(text).not.toContain('Terminal host')
    expect(text).not.toContain('Unattributed terminal processes')
  })

  it('says the sweep failed instead of letting zeros read as idle', () => {
    const text = render({ app: makeApp(zero), processSweep: 'failed' })
    expect(container.querySelector('[role="status"]')?.textContent).toContain('unknown, not zero')
    expect(text).not.toContain('Terminal host')
  })
})
