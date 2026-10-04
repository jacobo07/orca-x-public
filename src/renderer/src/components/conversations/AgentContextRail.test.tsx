// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AgentContextRail } from './AgentContextRail'

// IN-13b of 08-REVIEW: the rail printed main's lowercase "the stored agent catalog is unreadable".

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

describe('the agent context rail when the agent catalog cannot be read', () => {
  it('shows translated product copy, not the main-process message', () => {
    act(() => {
      root.render(
        <AgentContextRail
          row={null}
          grounding={{
            status: 'loaded',
            grounding: {
              outcome: 'roster-unreadable',
              reason: 'the stored agent catalog is unreadable'
            }
          }}
          turns={[]}
          liveTurnState="idle"
        />
      )
    })

    const error = container.querySelector('[data-testid="agent-context-error"]')
    expect(error?.textContent).toBe('Your agent list could not be read, and nothing was changed.')
    expect(container.textContent).not.toContain('the stored agent catalog')
  })
})
