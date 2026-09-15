import { describe, expect, it } from 'vitest'
import { appendBufferedDictation } from './terminal-live-dictation-routing'

describe('buffered dictation append', () => {
  it('replaces an empty or whitespace-only buffered field', () => {
    expect(appendBufferedDictation('', 'spoken')).toBe('spoken')
    expect(appendBufferedDictation('   ', 'spoken')).toBe('spoken')
  })

  it('appends after existing buffered text with one separating space', () => {
    expect(appendBufferedDictation('ls -la', 'in src')).toBe('ls -la in src')
    expect(appendBufferedDictation('ls -la   ', 'in src')).toBe('ls -la in src')
  })
})
