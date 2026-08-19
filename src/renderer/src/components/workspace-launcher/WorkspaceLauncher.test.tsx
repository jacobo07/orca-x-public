// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceLauncher } from './WorkspaceLauncher'

const state = {
  repos: [] as { id: string; displayName: string; path: string; addedAt: number }[],
  recentProjectIds: [] as string[],
  worktreesByRepo: {} as Record<string, { id: string }[]>,
  setActiveWorktree: vi.fn<(worktreeId: string) => boolean>(),
  setActiveView: vi.fn(),
  openModal: vi.fn()
}

vi.mock('@/store', () => ({
  useAppStore: (selector: (value: typeof state) => unknown) => selector(state)
}))

function project(id: string, displayName: string, path: string): (typeof state.repos)[number] {
  return { id, displayName, path, addedAt: 0 }
}

let container: HTMLDivElement | null = null
let root: Root | null = null

function render(): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(<WorkspaceLauncher />)
  })
}

function buttonWithText(text: string): HTMLButtonElement {
  const match = [...(container?.querySelectorAll('button') ?? [])].find((button) =>
    button.textContent?.includes(text)
  )
  if (!match) {
    throw new Error(`No button containing "${text}"`)
  }
  return match as HTMLButtonElement
}

function projectRowLabels(): string[] {
  // Recent rows are the buttons holding a path-titled span; the action buttons above hold none.
  return [...(container?.querySelectorAll('button') ?? [])]
    .filter((button) => button.querySelector('span[title]') !== null)
    .map((button) => button.querySelector('span')?.textContent ?? '')
    .filter(Boolean)
}

function typeFilter(value: string): void {
  const input = container?.querySelector('input')
  if (!input) {
    throw new Error('Filter input not rendered')
  }
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  state.repos = [
    project('orca', 'Orca X', '/home/user/Cursor Projects/Orca X'),
    project('titan', 'Titan Launcher', '/home/user/Repos/titan')
  ]
  state.recentProjectIds = ['orca', 'titan']
  state.worktreesByRepo = { orca: [{ id: 'orca-main' }], titan: [{ id: 'titan-main' }] }
  state.setActiveWorktree.mockReturnValue(true)
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  container?.remove()
  container = null
  root = null
})

describe('WorkspaceLauncher', () => {
  it('opens a recent project into the workbench', () => {
    render()

    act(() => {
      buttonWithText('Orca X').click()
    })

    expect(state.setActiveWorktree).toHaveBeenCalledWith('orca-main')
    expect(state.setActiveView).toHaveBeenCalledWith('terminal')
  })

  it('stays on the launcher when the workspace refuses to activate', () => {
    // The discrimination that matters: a refused activation and a successful one are different
    // outcomes. Navigating on a refusal would show an empty workbench and read as a broken open.
    state.setActiveWorktree.mockReturnValue(false)
    render()

    act(() => {
      buttonWithText('Titan Launcher').click()
    })

    expect(state.setActiveWorktree).toHaveBeenCalledWith('titan-main')
    expect(state.setActiveView).not.toHaveBeenCalled()
  })

  it('narrows the list as the filter is typed, matching name or path', () => {
    render()
    expect(projectRowLabels()).toEqual(['Orca X', 'Titan Launcher'])

    typeFilter('titan')
    expect(projectRowLabels()).toEqual(['Titan Launcher'])

    typeFilter('cursor')
    expect(projectRowLabels()).toEqual(['Orca X'])
  })

  it('reports an empty filter result separately from having no projects', () => {
    render()
    typeFilter('nothing-matches-this')

    expect(projectRowLabels()).toEqual([])
    expect(container?.textContent).toContain('No project matches')
    // The no-projects copy invites adding one, which is the wrong advice when projects exist.
    expect(container?.textContent).not.toContain('Add a project to get started')
  })

  it('offers only the add-project action when no project exists yet', () => {
    state.repos = []
    state.recentProjectIds = []
    state.worktreesByRepo = {}
    render()

    expect(container?.textContent).toContain('Add a project to get started')
    expect(container?.querySelector('input')).toBeNull()
    expect(buttonWithText('Create workspace').disabled).toBe(true)

    act(() => {
      buttonWithText('Open project').click()
    })
    expect(state.openModal).toHaveBeenCalledWith('add-repo')
  })

  it('disables a recent row whose worktrees have not loaded rather than dropping it', () => {
    // Hiding it would read as the project being gone; the row stays and refuses the click.
    state.worktreesByRepo = { orca: [{ id: 'orca-main' }] }
    render()

    expect(projectRowLabels()).toEqual(['Orca X', 'Titan Launcher'])
    expect(buttonWithText('Titan Launcher').disabled).toBe(true)
  })
})
