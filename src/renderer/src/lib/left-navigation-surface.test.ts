import { describe, expect, it, vi } from 'vitest'
import type { SidePanelDock } from '../../../shared/ui-chrome-types'
import { revealProjectSidebar } from './left-navigation-surface'

function makeState(args: {
  sidebarOpen: boolean
  sidePanelDock: SidePanelDock
  rightSidebarOpen: boolean
}) {
  return { ...args, setSidebarOpen: vi.fn(), toggleRightSidebar: vi.fn() }
}

describe('revealProjectSidebar', () => {
  it('closes a left-docked open panel, because opening the sidebar alone leaves it yielded', () => {
    const state = makeState({ sidebarOpen: true, sidePanelDock: 'left', rightSidebarOpen: true })

    const changed = revealProjectSidebar(state)

    expect(changed).toBe(true)
    expect(state.setSidebarOpen).toHaveBeenCalledWith(true)
    expect(state.toggleRightSidebar).toHaveBeenCalledTimes(1)
  })

  it('leaves a right-docked panel open: the two surfaces do not compete there', () => {
    const state = makeState({ sidebarOpen: false, sidePanelDock: 'right', rightSidebarOpen: true })

    const changed = revealProjectSidebar(state)

    expect(changed).toBe(true)
    expect(state.setSidebarOpen).toHaveBeenCalledWith(true)
    expect(state.toggleRightSidebar).not.toHaveBeenCalled()
  })

  it('reports no change when the sidebar already holds the region', () => {
    const state = makeState({ sidebarOpen: true, sidePanelDock: 'left', rightSidebarOpen: false })

    const changed = revealProjectSidebar(state)

    expect(changed).toBe(false)
    expect(state.setSidebarOpen).not.toHaveBeenCalled()
    expect(state.toggleRightSidebar).not.toHaveBeenCalled()
  })
})
