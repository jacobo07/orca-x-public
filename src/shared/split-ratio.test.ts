import { describe, expect, test } from 'vitest'
import { EVEN_SPLIT_RATIO, isUsableSplitRatio, normalizeSplitRatio } from './split-ratio'

describe('isUsableSplitRatio', () => {
  test.each([0.02, 0.25, EVEN_SPLIT_RATIO, 0.98])('accepts %s', (ratio) => {
    expect(isUsableSplitRatio(ratio)).toBe(true)
  })

  // Why 0 and 1 are rejected rather than clamped: either end gives one child a zero flex basis,
  // which is the collapsed-pane state this guard exists to prevent.
  test.each([
    ['zero', 0],
    ['one', 1],
    ['negative', -0.3],
    ['above one', 42],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a numeric string', '0.4'],
    ['null', null],
    ['undefined', undefined]
  ])('rejects %s', (_label, ratio) => {
    expect(isUsableSplitRatio(ratio)).toBe(false)
  })
})

describe('normalizeSplitRatio', () => {
  test('returns a usable ratio unchanged', () => {
    expect(normalizeSplitRatio(0.35)).toBe(0.35)
  })

  test('returns undefined for an unusable ratio so the reader falls back to an even split', () => {
    expect(normalizeSplitRatio(Number.NaN)).toBeUndefined()
    expect(normalizeSplitRatio(-1)).toBeUndefined()
  })

  test('leaves an absent ratio absent rather than materializing the default', () => {
    expect(normalizeSplitRatio(undefined)).toBeUndefined()
  })
})
