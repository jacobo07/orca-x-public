import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AutomationListLastRunCell } from './AutomationListLastRunCell'
import type { AutomationLastRunSnapshot, AutomationLastRunTone } from './automation-list-last-run'

const NOW = Date.UTC(2026, 8, 6, 12, 0, 0)

// Why: hold the text identical across tones so the only thing that can differ in the markup is the
// tone channel itself. Otherwise the status word would carry the distinction and hide whether the
// colour channel carries any.
function render(tone: AutomationLastRunTone): string {
  const snapshot: AutomationLastRunSnapshot = {
    at: NOW - 60_000,
    tone,
    statusLabel: 'Status'
  }
  return renderToStaticMarkup(
    React.createElement(AutomationListLastRunCell, { snapshot, now: NOW })
  )
}

describe('AutomationListLastRunCell', () => {
  it('does not borrow the destructive action role for a run outcome', () => {
    // docs/STYLEGUIDE.md scopes `destructive` to irreversible *actions* — a button that deletes
    // something. A last run that failed is a state, and --status-error is the role for that.
    const markup = render('failed')

    expect(markup).toContain('status-error')
    expect(markup).not.toContain('destructive')
  })

  it('stops an unknown outcome from looking like a successful one', () => {
    // Why: the renderer collapsed six tones to failed-or-not, so `unknown` painted exactly like
    // `succeeded`. A run whose status Orca could not read then looked like one it read as fine,
    // which is the one direction an unknown state must never be allowed to lean.
    expect(render('unknown')).not.toBe(render('succeeded'))
  })

  it('keeps an unknown outcome quiet rather than alarming', () => {
    // The other direction: unknown is not a failure either. It gets neither tone.
    expect(render('unknown')).not.toContain('status-error')
    expect(render('unknown')).not.toContain('status-success')
  })

  it('still tells a failure apart from a success', () => {
    expect(render('failed')).not.toBe(render('succeeded'))
  })
})
