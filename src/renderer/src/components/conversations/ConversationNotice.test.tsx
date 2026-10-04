// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ConversationNotice } from './ConversationNotice'
import type { ConversationNoticeKind } from './conversation-live-state'

// IN-13a of 08-REVIEW: restarting re-reads the same unreadable catalog, so the notice for that
// cause must not say "Restart Orca and try again."

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function textFor(kind: ConversationNoticeKind): string {
  act(() => {
    root.render(<ConversationNotice notice={{ kind, detail: null, userMessageKept: false }} />)
  })
  return container.querySelector('[data-testid="conversation-notice"] p')?.textContent ?? ''
}

describe('the notice for an agent that cannot be checked', () => {
  it('names an unreadable agent list, with no restart advice that cannot help', () => {
    const text = textFor('agent-catalog-unreadable')

    expect(text).toBe(
      'Your agent list could not be read, so nothing was sent and nothing was changed.'
    )
    expect(text).not.toMatch(/restart|try again/i)
  })

  it('keeps the existing sentence for an agent that is unverifiable for another reason', () => {
    expect(textFor('agent-unverifiable')).toContain('Restart Orca and try again.')
  })
})
