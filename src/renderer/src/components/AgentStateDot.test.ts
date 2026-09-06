import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentStateDot, agentStateLabel, type AgentDotState } from './AgentStateDot'

function renderMarkup(state: AgentDotState): string {
  return renderToStaticMarkup(React.createElement(AgentStateDot, { state }))
}

describe('AgentStateDot', () => {
  it('keeps the question glyph above the light-theme non-text contrast floor', () => {
    const css = readFileSync(join(__dirname, '../assets/main.css'), 'utf8')
    const lightTheme = css.match(/:root\s*\{(?<body>[\s\S]*?)\n\}/)?.groups?.body
    const darkTheme = css.match(/\.dark\s*\{(?<body>[\s\S]*?)\n\}/)?.groups?.body

    expect(lightTheme).toContain('--agent-question: var(--color-orange-600)')
    expect(darkTheme).toContain('--agent-question: var(--color-orange-500)')
  })

  it('defines the status-error role in both themes', () => {
    // Why: a token defined only under :root renders a dark-theme surface from whatever the light
    // value inherits, which is a contrast failure nobody sees in review because reviewers read one
    // theme. --status-error is deliberately separate from --destructive, which docs/STYLEGUIDE.md
    // scopes to irreversible actions rather than to states.
    const css = readFileSync(join(__dirname, '../assets/main.css'), 'utf8')
    const lightTheme = css.match(/:root\s*\{(?<body>[\s\S]*?)\n\}/)?.groups?.body
    const darkTheme = css.match(/\.dark\s*\{(?<body>[\s\S]*?)\n\}/)?.groups?.body

    expect(lightTheme).toContain('--status-error:')
    expect(darkTheme).toContain('--status-error:')
    expect(css).toContain('--color-status-error: var(--status-error)')
  })

  it('renders working as a yellow spinner', () => {
    const markup = renderMarkup('working')

    expect(markup).toContain('border-yellow-500')
    expect(markup).toContain('border-t-transparent')
    // Why: rotation must come from the compositor-driven CSS animation, not a
    // JS clock writing per-element styles on the input thread (STA-3328).
    expect(markup).toContain('agent-working-spinner')
    expect(markup).toContain('data-agent-spinner')
    // Why: under reduced motion the top border is filled so the static ring
    // reads as a complete marker, not a broken partial spinner (#9515).
    expect(markup).toContain('motion-reduce:border-t-yellow-500')
  })

  it('renders done as an emerald check icon', () => {
    const markup = renderMarkup('done')

    // Why: 'done' renders a CircleCheck icon rather than a dot so it is
    // visually distinct from other emerald-adjacent states across surfaces.
    // Note: the sidebar's StatusIndicator intentionally diverges and uses an
    // emerald dot for 'done'. Assertion targets the lucide 'circle-check'
    // class hook + emerald text color, identifying the check icon without
    // coupling to the exact SVG path markup lucide emits.
    expect(markup).toContain('lucide-circle-check')
    expect(markup).toContain('text-emerald-500')
  })

  it.each(['permission', 'waiting'] satisfies AgentDotState[])(
    'renders %s as the shared question glyph',
    (state) => {
      const markup = renderMarkup(state)

      expect(markup).toContain('lucide-message-circle-question-mark')
      // One token across sidebar, tabs, dashboard and map — never a raw hue.
      expect(markup).toContain('text-agent-question')
      expect(markup).not.toContain('text-amber-500')
      expect(markup).not.toContain('data-agent-spinner')
    }
  )

  // Why: the accessible name already differs for every state, so comparing whole markup would
  // report these as distinct while they paint identically. Strip the name to leave only what a
  // sighted user actually receives.
  function visualSignature(state: AgentDotState): string {
    return renderMarkup(state).replace(/aria-label="[^"]*"/g, '')
  }

  it('tells a failure apart from a block', () => {
    // Blocked means something must be unblocked; failed means something must be investigated or
    // retried. Different operator action, so they cannot share one glyph.
    expect(visualSignature('failed')).not.toBe(visualSignature('blocked'))
  })

  it('does not raise an interrupted run to the same alarm as a block', () => {
    // 'interrupted' is a variant of done — the runtime models it as done with a flag, not as a
    // peer of blocked (see the done:interrupted grouping in ActivityPrototypePage). Painting it
    // as the blocked attention dot manufactures urgency for work that merely stopped.
    expect(visualSignature('interrupted')).not.toBe(visualSignature('blocked'))
  })

  it.each(['blocked', 'interrupted', 'failed'] satisfies AgentDotState[])(
    'still names %s exactly',
    (state) => {
      expect(renderMarkup(state)).toContain(`aria-label="${agentStateLabel(state)}"`)
    }
  )
})
