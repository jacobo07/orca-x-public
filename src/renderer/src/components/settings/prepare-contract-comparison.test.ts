import { describe, expect, it } from 'vitest'
import { compareContractSources } from './prepare-contract-comparison'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

describe('compareContractSources', () => {
  it('flags a differing contract', () => {
    const result = compareContractSources([
      { hostKey: 'laptop@1', contract: 'parsed', contentHash: A },
      { hostKey: 'box@2', contract: 'parsed', contentHash: B }
    ])
    expect(result.get('laptop@1')).toEqual(['box@2'])
    expect(result.get('box@2')).toEqual(['laptop@1'])
  })

  it('equal contracts are not flagged', () => {
    const result = compareContractSources([
      { hostKey: 'laptop@1', contract: 'parsed', contentHash: A },
      { hostKey: 'box@2', contract: 'parsed', contentHash: A }
    ])
    expect(result.size).toBe(0)
  })

  it('treats an absent contract as its own value', () => {
    const result = compareContractSources([
      { hostKey: 'laptop@1', contract: 'parsed', contentHash: A },
      { hostKey: 'box@2', contract: 'absent' }
    ])
    expect(result.get('laptop@1')).toEqual(['box@2'])
    expect(result.get('box@2')).toEqual(['laptop@1'])
  })

  it('does not compare an unreadable or unparseable contract', () => {
    const result = compareContractSources([
      { hostKey: 'laptop@1', contract: 'parsed', contentHash: A },
      { hostKey: 'box@2', contract: 'unreadable' },
      { hostKey: 'vm@3', contract: 'unparseable' }
    ])
    expect(result.size).toBe(0)
  })

  it('lists nothing for a single block', () => {
    expect(
      compareContractSources([{ hostKey: 'laptop@1', contract: 'parsed', contentHash: A }]).size
    ).toBe(0)
  })

  it('lists every differing host when three hosts disagree', () => {
    const result = compareContractSources([
      { hostKey: 'h1', contract: 'parsed', contentHash: A },
      { hostKey: 'h2', contract: 'parsed', contentHash: A },
      { hostKey: 'h3', contract: 'parsed', contentHash: B }
    ])
    expect(result.get('h1')).toEqual(['h3'])
    expect(result.get('h3')).toEqual(['h1', 'h2'])
  })
})
