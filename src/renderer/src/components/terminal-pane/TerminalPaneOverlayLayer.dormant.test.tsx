/** @vitest-environment happy-dom */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../store/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const holder = vi.hoisted(() => ({
  store: null as unknown,
  paneRenders: [] as string[]
}))

vi.mock('./TerminalPane', () => ({
  default: ({ tabId }: { tabId: string }) => {
    holder.paneRenders.push(tabId)
    return null
  }
}))
// Why a delegate: slices import the store module before the test store exists.
vi.mock('@/store', () => {
  type Hook = ((selector?: unknown) => unknown) & {
    getState: () => unknown
    setState: (partial: unknown) => void
    subscribe: (listener: unknown) => () => void
  }
  const target = () => holder.store as Hook
  const useAppStore = Object.assign((selector?: unknown) => target()(selector), {
    getState: () => target().getState(),
    setState: (partial: unknown) => target().setState(partial),
    subscribe: (listener: unknown) => target().subscribe(listener)
  })
  return { useAppStore }
})
vi.mock('./use-terminal-tab-cold-parking', () => ({ useTerminalTabColdParking: () => new Set() }))
vi.mock('../native-chat/use-native-chat-toggle-shortcut', () => ({
  useNativeChatToggleShortcut: () => undefined
}))

const { createTestStore } = await import('../../store/slices/store-test-helpers')
const store = createTestStore()
holder.store = store
const { default: TerminalPaneOverlayLayer } = await import('./TerminalPaneOverlayLayer')

const WT = 'repo-1::C:/work/orca'
const DORMANT = { reason: 'working-set-restore' } as const

function seed(): void {
  const tab = (id: string, dormant: boolean) => ({
    id,
    ptyId: null,
    worktreeId: WT,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...(dormant ? { dormancy: DORMANT } : {})
  })
  const unified = (id: string, groupId: string) => ({
    id,
    entityId: id,
    groupId,
    worktreeId: WT,
    contentType: 'terminal' as const,
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    isPreview: false,
    isPinned: false
  })
  store.setState({
    tabsByWorktree: {
      [WT]: [tab('dormant-a', true), tab('dormant-b', true), tab('fresh-c', false)]
    },
    unifiedTabsByWorktree: {
      [WT]: [unified('dormant-a', 'g1'), unified('dormant-b', 'g1'), unified('fresh-c', 'g2')]
    },
    groupsByWorktree: {
      [WT]: [
        {
          id: 'g1',
          worktreeId: WT,
          activeTabId: 'dormant-a',
          tabOrder: ['dormant-a', 'dormant-b'],
          recentTabIds: ['dormant-a']
        },
        {
          id: 'g2',
          worktreeId: WT,
          activeTabId: 'fresh-c',
          tabOrder: ['fresh-c'],
          recentTabIds: ['fresh-c']
        }
      ]
    },
    activeGroupIdByWorktree: { [WT]: 'g1' }
  } as unknown as Partial<AppState>)
}

let container: HTMLDivElement
let root: Root

function render(isWorktreeActive: boolean): void {
  act(() => {
    root.render(
      <TerminalPaneOverlayLayer
        worktreeId={WT}
        worktreePath="C:/work/orca"
        isWorktreeActive={isWorktreeActive}
      />
    )
  })
}

const placeholders = () =>
  [...container.querySelectorAll<HTMLElement>('[data-testid="dormant-terminal-placeholder"]')].map(
    (el) => el.dataset.dormantTerminalTabId
  )

beforeEach(() => {
  holder.paneRenders.length = 0
  seed()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('dormant terminals in the split overlay', () => {
  it('shows the selected dormant tab as a placeholder and mounts only the unmarked tab', () => {
    render(true)
    expect(new Set(holder.paneRenders)).toEqual(new Set(['fresh-c']))
    expect(placeholders()).toEqual(['dormant-a'])
  })

  it('renders nothing for dormant tabs while the workspace is hidden', () => {
    render(false)
    // Control: the layer did render, it kept the unmarked tab's pane mounted while hidden.
    expect(holder.paneRenders).toContain('fresh-c')
    expect(placeholders()).toEqual([])
    expect(holder.paneRenders).not.toContain('dormant-a')
    expect(holder.paneRenders).not.toContain('dormant-b')
  })

  it('says a slept tab is asleep and a restored tab is restored', () => {
    render(true)
    const reasonShown = () =>
      container.querySelector<HTMLElement>('[data-testid="dormant-terminal-placeholder"]')?.dataset
        .dormancyReason
    const title = () =>
      container.querySelector('[data-testid="dormant-terminal-placeholder"] p')?.textContent
    expect(reasonShown()).toBe('working-set-restore')
    const restoredTitle = title()

    act(() => {
      store.setState((s) => ({
        tabsByWorktree: {
          [WT]: s.tabsByWorktree[WT]!.map((t) =>
            t.id === 'dormant-a' ? { ...t, dormancy: { reason: 'workspace-sleep' as const } } : t
          )
        }
      }))
    })
    expect(reasonShown()).toBe('workspace-sleep')
    expect(title()).not.toBe(restoredTitle)
  })

  it('opening the placeholder mounts that tab and no dormant sibling', () => {
    render(true)
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="dormant-terminal-open"]'
    )
    expect(button).not.toBeNull()
    act(() => button!.click())
    expect(holder.paneRenders).toContain('dormant-a')
    expect(holder.paneRenders).not.toContain('dormant-b')
    expect(placeholders()).toEqual([])
  })
})
