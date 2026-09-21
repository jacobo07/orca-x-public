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

    expect(ledger.commitSupply({ generation: newer, incarnation, channel: 'thumbnail' })).toBe(
      'accept'
    )
    // Generation `older` started first and finished last. Keeping it would walk the thumbnail
    // backwards, which is the one thing a live preview may never do.
    expect(ledger.commitSupply({ generation: older, incarnation, channel: 'thumbnail' })).toBe(
      'superseded'
    )
    expect(ledger.suppliedGeneration).toBe(newer)
  })

  // Measured against packaged Orca: the first thumbnail was supplied, and the next three demands
  // were refused because the terminal had not written anything in between. An idle terminal never
  // bumps the counter, so "until the next write" means never, and the preview freezes on frame one.
  it('answers a fresh demand at a generation it has already supplied', () => {
    const ledger = new TaskbarPreviewSupplyLedger()
    const incarnation = ledger.currentIncarnation
    const generation = ledger.advance()

    expect(ledger.commitSupply({ generation, incarnation, channel: 'thumbnail' })).toBe('accept')
    // The shell asks again for reasons of its own — a dropped cache, a different surface, a resize.
    // It is asking for a bitmap it does not hold, and unchanged content is still an answer.
    expect(ledger.commitSupply({ generation, incarnation, channel: 'thumbnail' })).toBe('accept')
  })

  // The taskbar thumbnail and the window-sized live preview are different pictures. One counter
  // across both meant supplying the 250x148 thumbnail marked the 1530x913 Peek bitmap as satisfied,
  // and Peek was never supplied once.
  it('keeps the thumbnail and the live preview on their own fences', () => {
    const ledger = new TaskbarPreviewSupplyLedger()
    const incarnation = ledger.currentIncarnation
    const generation = ledger.advance()

    expect(ledger.commitSupply({ generation, incarnation, channel: 'thumbnail' })).toBe('accept')
    expect(ledger.commitSupply({ generation, incarnation, channel: 'live-preview' })).toBe('accept')
    expect(ledger.suppliedGenerationFor('thumbnail')).toBe(generation)
    expect(ledger.suppliedGenerationFor('live-preview')).toBe(generation)
  })

  it('still refuses an older raster on one channel after a newer one on the other', () => {
    const ledger = new TaskbarPreviewSupplyLedger()
    const incarnation = ledger.currentIncarnation
    const older = ledger.advance()
    const newer = ledger.advance()

    expect(ledger.commitSupply({ generation: newer, incarnation, channel: 'live-preview' })).toBe(
      'accept'
    )
    // Independent fences must not become no fence: this channel's own history is what it is judged
    // against, and the thumbnail has supplied nothing, so the older raster is still its newest.
    expect(ledger.commitSupply({ generation: older, incarnation, channel: 'thumbnail' })).toBe(
      'accept'
    )
    expect(ledger.commitSupply({ generation: older, incarnation, channel: 'live-preview' })).toBe(
      'superseded'
    )
  })

  // Both channels answered at one generation is the shape the real shell produced once the fence
  // stopped treating a request as a result: thumbnail then live preview, neither superseding the
  // other, with no terminal write between them.
  it('serves both channels from one unchanged generation', () => {
    const ledger = new TaskbarPreviewSupplyLedger()
    const incarnation = ledger.currentIncarnation
    const generation = ledger.advance()

    const decisions = [
      ledger.commitSupply({ generation, incarnation, channel: 'thumbnail' }),
      ledger.commitSupply({ generation, incarnation, channel: 'live-preview' }),
      ledger.commitSupply({ generation, incarnation, channel: 'thumbnail' })
    ]

    expect(decisions).toEqual(['accept', 'accept', 'accept'])
  })

  it('refuses a result rasterized for a window that no longer exists', () => {
    const ledger = new TaskbarPreviewSupplyLedger()
    const closedWindow = ledger.currentIncarnation
    const generation = ledger.advance()

    ledger.adoptIncarnation()

    // Native handles are reused, so without this the replacement window inherits the dead one's
    // picture — and it would be a plausible-looking picture of the wrong project.
    expect(
      ledger.commitSupply({ generation, incarnation: closedWindow, channel: 'thumbnail' })
    ).toBe('foreign-incarnation')
  })

  it('names a foreign incarnation as such even when its content is the newest there is', () => {
    const ledger = new TaskbarPreviewSupplyLedger()
    const closedWindow = ledger.currentIncarnation
    ledger.adoptIncarnation()
    const fresh = ledger.advance()

    // Checked before generation on purpose: content age is not what is wrong with this result.
    expect(
      ledger.commitSupply({ generation: fresh, incarnation: closedWindow, channel: 'thumbnail' })
    ).toBe('foreign-incarnation')
  })

  it('lets the replacement window answer its own first demand', () => {
    const ledger = new TaskbarPreviewSupplyLedger()
    const generation = ledger.advance()
    expect(
      ledger.commitSupply({
        generation,
        incarnation: ledger.currentIncarnation,
        channel: 'thumbnail'
      })
    ).toBe('accept')

    // Without resetting what was supplied, the new window's first render would look superseded by
    // the old window's and the taskbar would sit empty until the next terminal write.
    const replacement = ledger.adoptIncarnation()
    expect(ledger.isStale).toBe(true)
    expect(
      ledger.commitSupply({ generation, incarnation: replacement, channel: 'thumbnail' })
    ).toBe('accept')
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
    expect(
      ledger.commitSupply({ generation: ledger.generation, incarnation, channel: 'thumbnail' })
    ).toBe('accept')
    expect(ledger.isStale).toBe(false)
  })

  it('does not hint at the shell when Windows already holds current content', () => {
    const ledger = new TaskbarPreviewSupplyLedger()
    const generation = ledger.advance()
    ledger.commitSupply({
      generation,
      incarnation: ledger.currentIncarnation,
      channel: 'thumbnail'
    })
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
    ledger.commitSupply({
      generation: first,
      incarnation: ledger.currentIncarnation,
      channel: 'thumbnail'
    })
    ledger.advance()

    // Accepting a bitmap is Windows taking it, not a person seeing it. The gap between these two
    // numbers is the part of freshness Orca owns; the rest belongs to the shell.
    expect(ledger.suppliedGeneration).toBe(first)
    expect(ledger.generation).toBeGreaterThan(ledger.suppliedGeneration)
    expect(ledger.isStale).toBe(true)
  })
})
