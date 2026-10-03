import { useEffect, useState, type RefObject } from 'react'

/**
 * True once the element has entered the viewport. Sticky: a preview already fetched stays drawn
 * when scrolled away, and the fetch cache makes a return free.
 */
export function useSeenInView(ref: RefObject<Element | null>): boolean {
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (seen || !element) {
      return
    }
    // Why: without an observer (old engine, test DOM) there is no way to defer, so load.
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true)
      return
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setSeen(true)
        observer.disconnect()
      }
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref, seen])
  return seen
}
