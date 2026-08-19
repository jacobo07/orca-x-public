import { useEffect, useState } from 'react'
import type { MenuTopLevelItem } from '../../../shared/app-menu-strip'

/**
 * The horizontal application-menu strip for platforms whose native menu bar is hidden.
 *
 * The strip renders the labels of the menu Electron actually registered and, on click, pops that
 * same submenu at the button. It never declares items of its own, so a visible entry without a
 * working action is not something to be disciplined about — it cannot be constructed.
 *
 * With no items — on the web runtime, or before the menu is registered — the caller's fallback
 * renders instead, so the application menu is never left unreachable.
 */
export function AppMenuStrip({ fallback = null }: { fallback?: React.ReactNode } = {}): React.ReactNode {
  const [items, setItems] = useState<readonly MenuTopLevelItem[]>([])

  useEffect(() => {
    let cancelled = false
    void window.api.ui
      .getMenuTopLevelItems()
      .then((topLevelItems) => {
        if (!cancelled) {
          setItems(topLevelItems)
        }
      })
      .catch(() => {
        // A menu that cannot be read is a strip that should not render, not an error to surface.
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (items.length === 0) {
    return fallback
  }

  const popupAt = (event: React.MouseEvent<HTMLButtonElement>, index: number): void => {
    const bounds = event.currentTarget.getBoundingClientRect()
    // Why the button's own bottom-left: the drop-down should hang under the label the user
    // clicked, which is where a native menu bar puts it.
    window.api.ui.popupMenu({ topLevelIndex: index, x: bounds.left, y: bounds.bottom })
  }

  return (
    <div className="flex items-center gap-0.5">
      {items.map((item) => (
        <button
          key={item.index}
          type="button"
          className="titlebar-menu-strip-button"
          disabled={!item.enabled}
          onClick={(event) => popupAt(event, item.index)}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
