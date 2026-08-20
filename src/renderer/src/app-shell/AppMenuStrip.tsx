import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MenuTopLevelItem } from '../../../shared/app-menu-strip'

/**
 * Collapse the strip to the compact menu button when the labels do not fit the space the titlebar
 * gives them.
 *
 * Why measured rather than gated on a breakpoint: the space is the sidebar's width, which the user
 * drags. Without this the buttons overflow their header and are painted over the sidebar toggle and
 * the back/forward pair — controls that are still clickable underneath, so nothing looks broken
 * enough to report while the titlebar quietly stops working.
 *
 * Two measurements, both deliberately state-independent, because anything that shrinks when the
 * strip collapses cannot decide whether the strip should come back. The natural width is remembered
 * from the renders that fit; the space is the titlebar header's own width, which is the sidebar's
 * and does not move when the strip inside it changes shape.
 */
/** Floor for the room the header owes its other controls, until they can be measured. */
const HEADER_CHROME_RESERVE_FLOOR_PX = 140
function useStripFits(itemCount: number): {
  wrapperRef: React.RefObject<HTMLDivElement | null>
  stripRef: React.RefObject<HTMLDivElement | null>
  fits: boolean
} {
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const stripRef = useRef<HTMLDivElement | null>(null)
  const naturalWidthRef = useRef(0)
  const reserveRef = useRef(HEADER_CHROME_RESERVE_FLOOR_PX)
  const [fits, setFits] = useState(true)

  useLayoutEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper || itemCount === 0) {
      return
    }
    const header = wrapper.closest('.titlebar-left') ?? wrapper.closest('.titlebar')
    if (!header) {
      return
    }
    const measure = (): void => {
      const strip = stripRef.current
      if (strip) {
        naturalWidthRef.current = Math.max(naturalWidthRef.current, strip.scrollWidth)
        // The other controls' width, taken only while the strip is laid out beside them, so it is
        // never the shrunken figure a collapsed strip reports. A guessed constant put the threshold
        // a few pixels off and the strip expanded straight back into an overlap.
        reserveRef.current = Math.max(reserveRef.current, header.clientWidth - wrapper.clientWidth)
      }
      setFits(
        naturalWidthRef.current === 0 ||
          header.clientWidth >= naturalWidthRef.current + reserveRef.current
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(header)
    return () => observer.disconnect()
  }, [itemCount])

  return { wrapperRef, stripRef, fits }
}

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
  const { wrapperRef, stripRef, fits } = useStripFits(items.length)

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
  if (!fits) {
    // Why the wrapper stays mounted: it is what measures the space, and the strip has to be able to
    // come back when the sidebar is widened again.
    return (
      <div ref={wrapperRef} className="flex min-w-0 flex-1 items-center">
        {fallback}
      </div>
    )
  }

  const popupAt = (event: React.MouseEvent<HTMLButtonElement>, index: number): void => {
    const bounds = event.currentTarget.getBoundingClientRect()
    // Why the button's own bottom-left: the drop-down should hang under the label the user
    // clicked, which is where a native menu bar puts it.
    window.api.ui.popupMenu({ topLevelIndex: index, x: bounds.left, y: bounds.bottom })
  }

  return (
    <div ref={wrapperRef} className="flex min-w-0 flex-1 items-center overflow-hidden">
      <div ref={stripRef} className="flex shrink-0 items-center gap-0.5">
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
    </div>
  )
}
