// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MenuPopupRequest, MenuTopLevelItem } from '../../../shared/app-menu-strip'
import { AppMenuStrip } from './AppMenuStrip'

const getMenuTopLevelItems = vi.fn<() => Promise<MenuTopLevelItem[]>>()
const popupMenu = vi.fn<(request?: MenuPopupRequest) => void>()

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  getMenuTopLevelItems.mockReset()
  popupMenu.mockReset()
  ;(window as unknown as { api: unknown }).api = {
    ui: { getMenuTopLevelItems, popupMenu }
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function render(fallback?: React.ReactNode): Promise<void> {
  await act(async () => {
    root.render(<AppMenuStrip fallback={fallback} />)
  })
}

const buttons = (): HTMLButtonElement[] =>
  [...container.querySelectorAll('button.titlebar-menu-strip-button')] as HTMLButtonElement[]

describe('AppMenuStrip', () => {
  it('renders the registered menu labels rather than its own', async () => {
    // Arrange
    getMenuTopLevelItems.mockResolvedValue([
      { index: 0, label: 'File', enabled: true },
      { index: 1, label: 'Edit', enabled: true },
      { index: 2, label: 'View', enabled: true }
    ])

    // Act
    await render()

    // Assert
    expect(buttons().map((button) => button.textContent)).toEqual(['File', 'Edit', 'View'])
  })

  it('pops the submenu the clicked label owns, under that label', async () => {
    // Arrange
    getMenuTopLevelItems.mockResolvedValue([
      { index: 0, label: 'File', enabled: true },
      { index: 3, label: 'View', enabled: true }
    ])
    await render()

    // Act — the second button, whose registered index is 3, not 1.
    await act(async () => {
      buttons()[1].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // Assert — the index travels from the real menu, so the strip cannot pop the wrong submenu.
    expect(popupMenu).toHaveBeenCalledTimes(1)
    expect(popupMenu.mock.calls[0][0]).toMatchObject({ topLevelIndex: 3 })
  })

  it('disables a label the registered menu reports disabled', async () => {
    // Arrange
    getMenuTopLevelItems.mockResolvedValue([{ index: 0, label: 'Run', enabled: false }])

    // Act
    await render()

    // Assert — disabled reflects real menu state, it is not decoration.
    expect(buttons()[0].disabled).toBe(true)
  })

  it('falls back when the runtime registers no menu', async () => {
    // Arrange — the web runtime has no native menu.
    getMenuTopLevelItems.mockResolvedValue([])

    // Act
    await render(<button className="fallback-menu-button">menu</button>)

    // Assert — the application menu stays reachable.
    expect(buttons()).toHaveLength(0)
    expect(container.querySelector('.fallback-menu-button')).not.toBeNull()
  })

  it('falls back when the menu cannot be read', async () => {
    // Arrange
    getMenuTopLevelItems.mockRejectedValue(new Error('no menu'))

    // Act
    await render(<button className="fallback-menu-button">menu</button>)

    // Assert
    expect(container.querySelector('.fallback-menu-button')).not.toBeNull()
  })
})
