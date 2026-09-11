import { describe, expect, it } from 'vitest'
import { TaskbarPreviewSupplyLedger } from './taskbar-preview-supply-ledger'

/**
 * Asynchronous supply is what DWM's late-answer allowance buys, and out-of-order completion is what
 * it costs. Every case here is a way the second answer to arrive is the wrong one to keep.
 */

describe('TaskbarPreviewSupplyLedger', () => {
  it('refuses a slow render of an older screen after a fast render of a newer one', () => {
    const ledger = new TaskbarPreviewSupplyLedger()
    const incarnation = ledger.currentIncarnation

    const older = ledger.advance()
    const newer = ledger.advance()

    expect(ledger.commitSupply({ generation: newer, incarnation })).toBe('accept')
    // Generation `older` started first and finished last. Keeping it would walk the thumbnail
    // backwards, which is the one thing a live preview may never do.
    expect(ledger.commitSupply({ generation: older, incarnation })).toBe('superseded')
    expect(ledger.suppliedGeneration).toBe(newer)
  })

  it('refuses a result rasterized for a window that no longer exists', () => {
    const ledger = new TaskbarPreviewSupplyLedger()
    const closedWindow = ledger.currentIncarnation
    const generation = ledger.advance()

    ledger.adoptIncarnation()

    // Native handles are reused, so without this the replacement window inherits the dead one's
    // picture — and it would be a plausible-looking picture of the wrong project.
    expect(ledger.commitSupply({ generation, incarnation: closedWindow })).toBe(
      'foreign-incarnation'
    )
  })

  it('names a foreign incarnation as such even when its content is the newest there is', () => {
    const ledger = new TaskbarPreviewSupplyLedger()
    const closedWindow = ledger.currentIncarnation
    ledger.adoptIncarnation()
    const fresh = ledger.advance()

    // Checked before generation on purpose: content age is not what is wrong with this result.
    expect(ledger.commitSupply({ generation: fresh, incarnation: closedWindow })).toBe(
      'foreign-incarnation'
    )
  })

  it('lets the replacement window answer its own first demand', () => {
    const ledger = new TaskbarPreviewSupplyLedger()
    const generation = ledger.advance()
    expect(ledger.commitSupply({ generation, incarnation: ledger.currentIncarnation })).toBe(
      'accept'
    )

    // Without resetting what was supplied, the new window's first render would look superseded by
    // the old window's and the taskbar would sit empty until the next terminal write.
    const replacement = ledger.adoptIncarnation()
    expect(ledger.isStale).toBe(true)
    expect(ledger.commitSupply({ generation, incarnation: replacement })).toBe('accept')
  })

  it('collapses a burst of output into one supply at the newest generation', () => {
    const ledger = new TaskbarPreviewSupplyLedger()
    const incarnation = ledger.currentIncarnation

    // Ninety writes land while one render is in flight. The renderer reads the current generation
    // when it starts, so this is a queue of zero, not of ninety.
    for (let index = 0; index < 90; index += 1) {
      ledger.advance()
    }
    expect(ledger.generation).toBe(90)
    expect(ledger.commitSupply({ generation: ledger.generation, incarnation })).toBe('accept')
    expect(ledger.isStale).toBe(false)
  })

  it('does not hint at the shell when Windows already holds current content', () => {
    const ledger = new TaskbarPreviewSupplyLedger()
    const generation = ledger.advance()
    ledger.commitSupply({ generation, incarnation: ledger.currentIncarnation })
    expect(ledger.shouldInvalidate(1_000, 300)).toBe(false)
  })

  it('rate limits the staleness hint instead of sending one per terminal write', () => {
    const ledger = new TaskbarPreviewSupplyLedger()
    ledger.advance()

    expect(ledger.shouldInvalidate(1_000, 300)).toBe(true)
    ledger.recordInvalidated(1_000)

    ledger.advance()
    expect(ledger.shouldInvalidate(1_100, 300)).toBe(false)
    expect(ledger.shouldInvalidate(1_300, 300)).toBe(true)
  })

  it('keeps supplied and current apart, because only one of them is about the user', () => {
    const ledger = new TaskbarPreviewSupplyLedger()
    const first = ledger.advance()
    ledger.commitSupply({ generation: first, incarnation: ledger.currentIncarnation })
    ledger.advance()

    // Accepting a bitmap is Windows taking it, not a person seeing it. The gap between these two
    // numbers is the part of freshness Orca owns; the rest belongs to the shell.
    expect(ledger.suppliedGeneration).toBe(first)
    expect(ledger.generation).toBeGreaterThan(ledger.suppliedGeneration)
    expect(ledger.isStale).toBe(true)
  })
})
