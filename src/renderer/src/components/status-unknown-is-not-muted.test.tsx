// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { IntegrationStatusPill } from './integration-status-pill'
import { SleepReclaimObservedReclaim } from './status-bar/SleepReclaimObservedReclaim'

// The defect this pins is not "unknown has no colour" — it is that unknown rendered in the
// EXACT class a real value renders in, so the two were indistinguishable on screen while
// meaning opposite things. Every assertion below is therefore a comparison against the
// measured/known sibling, not a check that some class is present: asserting presence alone
// would still pass if both states carried it.

describe('an unmeasured value does not render as a measured one', () => {
  it('SleepReclaimObservedReclaim: unmeasured and pending no longer share a treatment', () => {
    const { unmount } = render(
      <SleepReclaimObservedReclaim reclaim={{ status: 'unmeasured', reason: 'sweep-failed' }} />
    )
    const unmeasured = screen.getByTestId('sleep-reclaim-observed')
    expect(unmeasured.getAttribute('data-status')).toBe('unmeasured')
    const unmeasuredClass = unmeasured.className
    unmount()

    render(<SleepReclaimObservedReclaim reclaim="pending" />)
    const pending = screen.getByTestId('sleep-reclaim-observed')
    expect(pending.getAttribute('data-status')).toBe('pending')

    // The control. Pending is still muted, so this is a real distinction and not a sweep
    // that recoloured everything.
    expect(pending.className).toContain('text-muted-foreground')
    expect(unmeasuredClass).not.toContain('text-muted-foreground')
    expect(unmeasuredClass).toContain('text-status-unknown')
    expect(unmeasuredClass).not.toBe(pending.className)
  })

  it('an unmeasured reclaim with nothing slept still renders nothing', () => {
    // Absence of an effect is not an unknown. Keeping this pinned so the new treatment does
    // not turn "there was nothing to observe" into a visible uncertainty badge.
    const { container } = render(
      <SleepReclaimObservedReclaim reclaim={{ status: 'unmeasured', reason: 'nothing-slept' }} />
    )
    expect(container.firstChild).toBeNull()
  })
})

describe('IntegrationStatusPill tones resolve through the status tokens', () => {
  it('gives unknown a hollow dot where the other tones are filled', () => {
    const dotOf = (tone: 'connected' | 'attention' | 'unknown' | 'neutral'): Element => {
      const { container } = render(<IntegrationStatusPill tone={tone}>x</IntegrationStatusPill>)
      const dot = container.querySelector('span > span')
      if (!dot) {
        throw new Error(`no dot rendered for tone ${tone}`)
      }
      return dot
    }

    // Shape, not hue: this is what survives greyscale and 6px.
    expect(dotOf('unknown').className).toContain('bg-transparent')
    expect(dotOf('unknown').className).toContain('border-status-unknown')
    expect(dotOf('connected').className).toContain('bg-status-success')
    expect(dotOf('attention').className).toContain('bg-status-warning')
    expect(dotOf('connected').className).not.toContain('bg-transparent')
    expect(dotOf('attention').className).not.toContain('bg-transparent')
  })

  it('carries no raw amber or emerald scale literal any more', () => {
    for (const tone of ['connected', 'attention', 'unknown', 'neutral'] as const) {
      const { container, unmount } = render(
        <IntegrationStatusPill tone={tone}>x</IntegrationStatusPill>
      )
      expect(container.innerHTML).not.toMatch(/(amber|emerald|yellow|orange)-\d{2,3}/)
      unmount()
    }
  })

  it('keeps the four tones visually distinct from each other', () => {
    // A convergence that collapsed two meanings onto one recipe would pass every assertion
    // above. This is the one that notices.
    const pillClassOf = (tone: 'connected' | 'attention' | 'unknown' | 'neutral'): string => {
      const { container } = render(<IntegrationStatusPill tone={tone}>x</IntegrationStatusPill>)
      return (container.firstChild as HTMLElement).className
    }
    const classes = (['connected', 'attention', 'unknown', 'neutral'] as const).map(pillClassOf)
    expect(new Set(classes).size).toBe(4)
  })
})
