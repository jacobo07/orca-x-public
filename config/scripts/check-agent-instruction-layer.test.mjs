import { describe, expect, it } from 'vitest'

import {
  findReplacingSlotSites,
  stripComments,
  usesSlotInCode
} from './check-agent-instruction-layer.mjs'

// Synthetic subjects only: a drill pinned to today's driver has an interest in that file never
// changing, and would stop asserting anything the day it moves.

describe('findReplacingSlotSites', () => {
  it('refuses a production module that routes anything to baseInstructions', () => {
    const files = [{ path: 'src/main/x/other-driver.ts', source: 'rpc({ baseInstructions: role })' }]
    expect(findReplacingSlotSites(files)).toEqual(['src/main/x/other-driver.ts'])
  })

  it('does not accuse a module that only says so in a comment', () => {
    const source = [
      '// never baseInstructions: it replaces the provider layer',
      '/* baseInstructions would override governance */',
      'rpc({ developerInstructions: role })'
    ].join('\n')
    expect(findReplacingSlotSites([{ path: 'src/main/x/driver.ts', source }])).toEqual([])
  })

  it('exempts tests, which must name the slot in order to forbid it', () => {
    const files = [{ path: 'src/main/x/driver.test.ts', source: "expect(p).not.toHaveProperty('baseInstructions')" }]
    expect(findReplacingSlotSites(files)).toEqual([])
  })

  it('normalizes Windows separators', () => {
    const files = [{ path: 'src\\main\\x\\d.ts', source: 'const a = { baseInstructions: 1 }' }]
    expect(findReplacingSlotSites(files)).toEqual(['src/main/x/d.ts'])
  })
})

describe('usesSlotInCode — the positive control’s instrument', () => {
  it('sees the layered slot in code', () => {
    expect(usesSlotInCode('x = { developerInstructions: r }', 'developerInstructions')).toBe(true)
  })

  it('does not count a slot that exists only in a comment', () => {
    expect(usesSlotInCode('// developerInstructions\nx = 1', 'developerInstructions')).toBe(false)
  })

  it('keeps a URL, whose // is not a comment', () => {
    expect(stripComments("const u = 'https://x' // gone")).toBe("const u = 'https://x' ")
  })
})
