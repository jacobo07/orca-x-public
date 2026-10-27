/** @vitest-environment happy-dom */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneSessionResumeResult } from '@/lib/pane-session-resume-intent'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('./PaneSessionResumeBanner', () => ({ PaneSessionResumeBanner: () => null }))

const { PaneSessionResumeBannerPortals } = await import('./PaneSessionResumeBannerPortals')
const { hasPaneSessionResumeHandler, requestPaneSessionResume } =
  await import('@/lib/pane-session-resume-dispatch')

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'

let container: HTMLDivElement
let root: Root

function pane(id: number, leafId: string) {
  return { id, leafId, container: document.createElement('div') }
}

describe('PaneSessionResumeBannerPortals', () => {
  beforeEach(() => {
    container = document.createElement('div')
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
  })

  it('offers each mounted pane’s own resume under its own key, and withdraws it on unmount', async () => {
    const onResume = vi.fn(
      async (_paneId: number): Promise<PaneSessionResumeResult> => ({ outcome: 'started' })
    )
    act(() => {
      root.render(
        <PaneSessionResumeBannerPortals
          panes={[pane(1, LEAF_A), pane(2, LEAF_B)]}
          tabId="tab-1"
          worktreeId="wt-1"
          onResume={onResume}
        />
      )
    })

    await requestPaneSessionResume(`tab-1:${LEAF_B}`)
    expect(onResume).toHaveBeenCalledTimes(1)
    expect(onResume).toHaveBeenCalledWith(2)

    act(() => root.unmount())
    root = createRoot(container)
    expect(hasPaneSessionResumeHandler(`tab-1:${LEAF_A}`)).toBe(false)
    expect(hasPaneSessionResumeHandler(`tab-1:${LEAF_B}`)).toBe(false)
  })
})
