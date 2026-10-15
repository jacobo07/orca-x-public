import { describe, expect, it } from 'vitest'
import { nodeRequirementFromFlags } from './node-requirement-flags'

const MB = 1024 * 1024
const flagsOf = (entries: [string, string | boolean][]) =>
  new Map<string, string | boolean>(entries)

describe('nodeRequirementFromFlags', () => {
  it('returns undefined when no resource flag is given', () => {
    expect(nodeRequirementFromFlags(new Map(), { includeMemory: true })).toBeUndefined()
    expect(
      nodeRequirementFromFlags(flagsOf([['platform', 'linux']]), { includeMemory: true })
    ).toBeUndefined()
  })

  it('turns all three flags into byte figures per family', () => {
    expect(
      nodeRequirementFromFlags(
        flagsOf([
          ['min-available-mb', '4096'],
          ['min-vram-mb', '8192'],
          ['min-disk-mb', '100']
        ]),
        { includeMemory: true }
      )
    ).toStrictEqual({
      memory: { minAvailableBytes: 4096 * MB },
      disk: { minAvailableBytes: 100 * MB },
      vram: { minFreeBytes: 8192 * MB }
    })
  })

  it('carries only the families that were asked for', () => {
    expect(
      nodeRequirementFromFlags(flagsOf([['min-vram-mb', '8192']]), { includeMemory: true })
    ).toStrictEqual({ vram: { minFreeBytes: 8192 * MB } })
  })

  it('ignores min-available-mb when memory has its own legacy field', () => {
    expect(
      nodeRequirementFromFlags(flagsOf([['min-available-mb', '4096']]), { includeMemory: false })
    ).toBeUndefined()
    expect(
      nodeRequirementFromFlags(
        flagsOf([
          ['min-available-mb', '4096'],
          ['min-disk-mb', '5']
        ]),
        { includeMemory: false }
      )
    ).toStrictEqual({ disk: { minAvailableBytes: 5 * MB } })
  })

  it.each([
    ['1.5', 'min-vram-mb'],
    ['0', 'min-vram-mb'],
    ['-3', 'min-disk-mb'],
    ['abc', 'min-available-mb'],
    ['', 'min-vram-mb'],
    [' ', 'min-disk-mb'],
    ['0x10', 'min-vram-mb'],
    ['1e3', 'min-disk-mb'],
    ['1e308', 'min-vram-mb'],
    ['+5', 'min-disk-mb']
  ])('refuses %j for --%s naming the flag', (value, flag) => {
    expect(() =>
      nodeRequirementFromFlags(flagsOf([[flag, value]]), { includeMemory: true })
    ).toThrow(new RegExp(`--${flag}`))
  })

  it('refuses a flag given with no value instead of dropping it', () => {
    expect(() =>
      nodeRequirementFromFlags(flagsOf([['min-vram-mb', true]]), { includeMemory: true })
    ).toThrow(/--min-vram-mb/)
  })

  it('refuses a byte figure beyond the safe integer range', () => {
    const tooMany = String(Math.floor(Number.MAX_SAFE_INTEGER / MB) + 1)
    expect(() =>
      nodeRequirementFromFlags(flagsOf([['min-disk-mb', tooMany]]), { includeMemory: true })
    ).toThrow(/--min-disk-mb/)
    const largest = String(Math.floor(Number.MAX_SAFE_INTEGER / MB))
    expect(
      nodeRequirementFromFlags(flagsOf([['min-disk-mb', largest]]), { includeMemory: true })
    ).toStrictEqual({ disk: { minAvailableBytes: Number(largest) * MB } })
  })
})
