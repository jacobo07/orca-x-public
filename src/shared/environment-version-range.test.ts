import { describe, expect, it } from 'vitest'
import {
  extractFirstVersion,
  parseVersionRange,
  satisfiesVersionRange
} from './environment-version-range'

function satisfies(version: string, raw: string): boolean {
  const range = parseVersionRange(raw)
  if (range.status !== 'supported') {
    throw new Error(`range ${raw} unsupported`)
  }
  return satisfiesVersionRange(version, range.comparators)
}

describe('parseVersionRange', () => {
  it('accepts the closed comparator grammar', () => {
    expect(parseVersionRange('>=2.25').status).toBe('supported')
    expect(parseVersionRange('>=1.2 <2').status).toBe('supported')
    expect(parseVersionRange('=2.25.1').status).toBe('supported')
  })

  it.each(['^2', '~1.2', '>=1 || >=3', '1.x', '>=1.0.0-beta', '', '   ', 'latest', '>=', '>=a.b'])(
    'marks %j unsupported and keeps the raw text',
    (raw) => {
      const range = parseVersionRange(raw)
      expect(range).toEqual({ status: 'unsupported', raw })
    }
  )

  it('refuses an oversized range', () => {
    expect(parseVersionRange('>=1 '.repeat(100)).status).toBe('unsupported')
  })
})

describe('satisfiesVersionRange', () => {
  it('>=2.25 contains 2.25.0 and 2.45.1 but not 2.24.9', () => {
    expect(satisfies('2.25.0', '>=2.25')).toBe(true)
    expect(satisfies('2.45.1', '>=2.25')).toBe(true)
    expect(satisfies('2.24.9', '>=2.25')).toBe(false)
  })

  it('treats comparators as AND', () => {
    expect(satisfies('1.5.0', '>=1.2 <2')).toBe(true)
    expect(satisfies('2.0.0', '>=1.2 <2')).toBe(false)
    expect(satisfies('1.1.9', '>=1.2 <2')).toBe(false)
  })

  it('exact match needs every component', () => {
    expect(satisfies('2.25.1', '=2.25.1')).toBe(true)
    expect(satisfies('2.25.2', '=2.25.1')).toBe(false)
  })

  it('strict comparators exclude the bound', () => {
    expect(satisfies('2.0.0', '>2')).toBe(false)
    expect(satisfies('2.0.1', '>2')).toBe(true)
    expect(satisfies('2.0.0', '<=2')).toBe(true)
    expect(satisfies('2.0.1', '<=2')).toBe(false)
  })

  it('treats a missing minor or patch as zero', () => {
    expect(satisfies('20', '>=20.0.0')).toBe(true)
    expect(satisfies('20.11', '<20.12')).toBe(true)
  })

  it('does not satisfy anything for a version it cannot read', () => {
    expect(satisfies('not-a-version', '>=0')).toBe(false)
  })
})

describe('extractFirstVersion', () => {
  it('reads the first dotted number', () => {
    expect(extractFirstVersion('git version 2.45.1.windows.1')).toBe('2.45.1')
    expect(extractFirstVersion('v20.11.0')).toBe('20.11.0')
    expect(extractFirstVersion('gh version 2.40')).toBe('2.40')
  })

  it('returns null without a version token', () => {
    expect(extractFirstVersion('no digits here')).toBeNull()
    expect(extractFirstVersion('7')).toBeNull()
  })

  it('truncates input over 4096 chars before matching', () => {
    expect(extractFirstVersion(`${'x'.repeat(4096)}9.9.9`)).toBeNull()
    expect(extractFirstVersion(`1.2.3${'x'.repeat(5000)}`)).toBe('1.2.3')
  })
})
