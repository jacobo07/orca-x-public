import { describe, expect, it } from 'vitest'
import { mintProbeMarker } from './terminal-probe-marker'

describe('mintProbeMarker', () => {
  it('mints a different marker on every call, so a stale line cannot answer a new probe', () => {
    // Arrange
    const label = 'SURVIVOR_AFTER'

    // Act
    const first = mintProbeMarker(label)
    const second = mintProbeMarker(label)

    // Assert
    expect(first).not.toBe(second)
  })

  it('keeps the caller label as the prefix, followed by 8 hex chars', () => {
    expect(mintProbeMarker('DIRECT_POST_0')).toMatch(/^DIRECT_POST_0_[0-9a-f]{8}$/)
  })

  it('refuses a label a shell would not echo verbatim', () => {
    expect(() => mintProbeMarker('HAS SPACE')).toThrow()
    expect(() => mintProbeMarker('HAS$VAR')).toThrow()
    expect(() => mintProbeMarker('lower')).toThrow()
    expect(() => mintProbeMarker('')).toThrow()
  })
})
