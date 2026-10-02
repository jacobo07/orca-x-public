// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WORKSPACE_DESTINATIONS } from '@/lib/workspace-destinations'

// happy-dom never lays anything out, so the frame's width is driven here: the initial
// getBoundingClientRect reading and every ResizeObserver delivery after it.

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  width: 0,
  observers: [] as ((entries: { contentRect: { width: number } }[]) => void)[]
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.state)
}))

vi.mock('../conversations/WorkspaceExitButton', () => ({
  WorkspaceExitButton: () => <button type="button" data-testid="workspace-exit" />
}))

import { WORKSPACE_FRAME_COLUMN_MIN_PX, WorkspaceFrame } from './WorkspaceFrame'

let container: HTMLDivElement
let root: Root

function render(activeView: string, context: React.ReactNode | null = <p data-context="" />): void {
  mocks.state = {
    activeView,
    workspaceRosterTab: 'agents',
    openWorkspaceHome: vi.fn(),
    openWorkspaceDestination: vi.fn()
  }
  act(() => {
    root.render(
      <WorkspaceFrame context={context}>
        <div data-page="" />
      </WorkspaceFrame>
    )
  })
}

function resize(width: number): void {
  act(() => {
    for (const deliver of mocks.observers) {
      deliver([{ contentRect: { width } }])
    }
  })
}

function frame(): HTMLElement {
  return container.querySelector<HTMLElement>('[data-workspace-frame]')!
}

function navItems(variant: 'list' | 'strip'): string[] {
  return [
    ...container.querySelectorAll(`[data-workspace-nav="${variant}"] [data-workspace-nav-item]`)
  ].map((node) => node.getAttribute('data-workspace-nav-item') ?? '')
}

function detailsToggle(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('[data-workspace-frame-context-toggle]')
}

beforeEach(() => {
  mocks.observers = []
  mocks.width = 1400
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: (entries: { contentRect: { width: number } }[]) => void) {
        mocks.observers.push(callback)
      }
      observe(): void {}
      disconnect(): void {}
    }
  )
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ width: mocks.width }) as DOMRect
  )
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('WorkspaceFrame layout', () => {
  it('wide: one right column holding Workspace navigation and the context, no strip', () => {
    render('resumeCenter')

    expect(frame().getAttribute('data-workspace-frame-layout')).toBe('column')
    expect(
      container.querySelector('[data-workspace-frame-column=""] [data-context]')
    ).not.toBeNull()
    expect(navItems('list')).toEqual([...WORKSPACE_DESTINATIONS])
    expect(navItems('strip')).toEqual([])
    expect(detailsToggle()).toBeNull()
  })

  it('narrow: the column folds into a header strip that keeps every destination, in order', () => {
    mocks.width = 900
    render('resumeCenter')

    expect(frame().getAttribute('data-workspace-frame-layout')).toBe('strip')
    expect(container.querySelector('[data-workspace-frame-column]')).toBeNull()
    // Folding moves the destinations; it must not drop or reorder one.
    expect(navItems('strip')).toEqual([...WORKSPACE_DESTINATIONS])
    expect(navItems('list')).toEqual([])
  })

  it('narrow: Details opens the context as an overlay and closes it again', () => {
    mocks.width = 900
    render('resumeCenter')
    const toggle = detailsToggle()
    expect(toggle?.getAttribute('aria-pressed')).toBe('false')
    expect(container.querySelector('[data-workspace-frame-column="overlay"]')).toBeNull()

    act(() => toggle?.click())
    expect(toggle?.getAttribute('aria-pressed')).toBe('true')
    expect(
      container.querySelector('[data-workspace-frame-column="overlay"] [data-context]')
    ).not.toBeNull()

    act(() => toggle?.click())
    expect(container.querySelector('[data-workspace-frame-column="overlay"]')).toBeNull()
  })

  it('narrow with no context offers no Details control', () => {
    mocks.width = 900
    render('resumeCenter', null)
    expect(frame().getAttribute('data-workspace-frame-layout')).toBe('strip')
    expect(detailsToggle()).toBeNull()
  })

  it('folds at the threshold and follows later resizes; a 0 px reading keeps the last decision', () => {
    mocks.width = WORKSPACE_FRAME_COLUMN_MIN_PX
    render('resumeCenter')
    expect(frame().getAttribute('data-workspace-frame-layout')).toBe('column')

    // A hidden ancestor reports 0: not a reason to fold a column that is showing.
    resize(0)
    expect(frame().getAttribute('data-workspace-frame-layout')).toBe('column')
    resize(WORKSPACE_FRAME_COLUMN_MIN_PX - 1)
    expect(frame().getAttribute('data-workspace-frame-layout')).toBe('strip')
    resize(WORKSPACE_FRAME_COLUMN_MIN_PX)
    expect(frame().getAttribute('data-workspace-frame-layout')).toBe('column')
  })

  it('keeps the destination identity when folded: Backlog stays the current strip entry', () => {
    mocks.width = 900
    render('backlog')
    expect(frame().getAttribute('data-workspace-destination')).toBe('backlog')
    expect(
      container
        .querySelector('[data-workspace-nav="strip"] [data-workspace-nav-item="backlog"]')
        ?.getAttribute('aria-current')
    ).toBe('page')
    expect(
      container.querySelectorAll('[data-workspace-nav="strip"] [aria-current="page"]')
    ).toHaveLength(1)
  })
})
