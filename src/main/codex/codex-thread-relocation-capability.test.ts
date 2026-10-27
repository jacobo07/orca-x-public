import { describe, expect, it } from 'vitest'

import { codexThreadRelocation, codexVersionOf } from './codex-thread-relocation-capability'

const answer = (version: string) => ({
  userAgent: `orca_desktop/${version} (Ubuntu 24.4.0; x86_64) unknown (orca_desktop; 0.0.0)`
})

describe('codex thread relocation capability', () => {
  it('reads the version from the initialize answer measured on 0.155.1', () => {
    expect(codexVersionOf(answer('0.155.1'))).toEqual([0, 155, 1])
  })

  it('is supported from the measured floor, and UNKNOWN below it', () => {
    expect(codexThreadRelocation(answer('0.153.4'))).toBe('supported')
    expect(codexThreadRelocation(answer('0.155.1'))).toBe('supported')
    expect(codexThreadRelocation(answer('1.0.0'))).toBe('supported')
    expect(codexThreadRelocation(answer('0.153.3'))).toBe('unknown')
    expect(codexThreadRelocation(answer('0.99.9'))).toBe('unknown')
  })

  it('never reads an answer it cannot parse as capable', () => {
    for (const unreadable of [undefined, null, {}, { userAgent: 42 }, { userAgent: 'codex' }]) {
      expect(codexThreadRelocation(unreadable)).toBe('unknown')
    }
  })
})
