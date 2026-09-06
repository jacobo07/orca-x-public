import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { NativeChatDiffView } from './NativeChatDiffView'
import type { DiffLine } from './native-chat-diff'

// Why 120: that is DEFAULT_MAX_DIFF_LINES in shared/native-chat-diff.ts, so it is the largest diff
// the producers can hand this component. A fixture smaller than the real ceiling could not fail a
// height test — it would fit whatever bound existed.
const MAX_PRODUCIBLE_LINES = 120

function longDiff(): DiffLine[] {
  return Array.from({ length: MAX_PRODUCIBLE_LINES }, (_, index) => ({
    kind: index % 2 === 0 ? ('add' as const) : ('del' as const),
    text: `line ${index}`
  }))
}

describe('NativeChatDiffView', () => {
  it('bounds its own height the way every sibling detail branch does', () => {
    // Why: NativeChatToolRun caps its result body and its input detail at max-h-64 and lets them
    // scroll. The diff branch sat in the same component with no cap, so the one surface carrying
    // the most content was also the only one that could push ~2000px of conversation off screen.
    const markup = renderToStaticMarkup(
      React.createElement(NativeChatDiffView, { lines: longDiff() })
    )

    expect(markup).toContain('max-h-64')
    expect(markup).toContain('overflow-auto')
    expect(markup).not.toContain('overflow-hidden')
  })

  it('keeps every line the producer handed it', () => {
    // Bounding is a viewport decision, not a content one. The producers already truncate at their
    // own ceiling and mark it; this component must not drop anything on top of that.
    const markup = renderToStaticMarkup(
      React.createElement(NativeChatDiffView, { lines: longDiff() })
    )

    expect(markup).toContain('line 0')
    expect(markup).toContain(`line ${MAX_PRODUCIBLE_LINES - 1}`)
  })

  it('lets a keyboard reach the diff it just made scrollable', () => {
    // Why: turning a region into a scroller hides content behind an interaction, and a scroller
    // that only a mouse wheel can drive puts that content out of reach entirely.
    const markup = renderToStaticMarkup(
      React.createElement(NativeChatDiffView, { lines: longDiff() })
    )

    expect(markup).toContain('tabindex="0"')
    expect(markup).toMatch(/role="(?:region|group)"/)
    expect(markup).toMatch(/aria-label="[^"]+"/)
  })

  it('still marks additions and deletions apart', () => {
    const markup = renderToStaticMarkup(
      React.createElement(NativeChatDiffView, {
        lines: [
          { kind: 'add', text: 'added' },
          { kind: 'del', text: 'removed' }
        ]
      })
    )

    expect(markup).toContain('--git-decoration-added')
    expect(markup).toContain('--git-decoration-deleted')
  })
})
