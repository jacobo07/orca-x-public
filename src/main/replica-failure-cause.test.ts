import { describe, expect, it } from 'vitest'
import { isDiskFullError } from './replica-failure-cause'

const withCode = (code: string, message = 'x'): Error => Object.assign(new Error(message), { code })

describe('isDiskFullError', () => {
  it.each([
    ['ENOSPC code', withCode('ENOSPC')],
    ['EDQUOT code', withCode('EDQUOT')],
    ['errno string', Object.assign(new Error('x'), { errno: 'ENOSPC' })],
    ['git wording in message', new Error('error: unable to write file x: No space left on device')],
    ['git wording is case-insensitive', new Error('NO SPACE LEFT ON DEVICE')],
    ['quota wording', new Error('write failed: Disk quota exceeded')],
    ['windows wording', new Error('There is not enough space on the disk.')],
    [
      'wording only in stderr string',
      Object.assign(new Error('Command failed'), { stderr: 'fatal: No space left on device' })
    ],
    [
      'wording only in stderr buffer',
      Object.assign(new Error('Command failed'), { stderr: Buffer.from('Disk quota exceeded') })
    ],
    ['nested cause code', Object.assign(new Error('wrapper'), { cause: withCode('ENOSPC') })],
    [
      'nested cause wording',
      Object.assign(new Error('wrapper'), { cause: new Error('no space left on device') })
    ]
  ])('is true for %s', (_name, error) => {
    expect(isDiskFullError(error)).toBe(true)
  })

  it.each([
    ['ECONNRESET', withCode('ECONNRESET', 'read ECONNRESET')],
    ['EPIPE', withCode('EPIPE', 'write EPIPE')],
    ['EACCES', withCode('EACCES', 'permission denied')],
    ['relay close message', new Error('relay connection closed')],
    ['device busy message', new Error('device busy')],
    ['space without the phrases', new Error('no space between the arguments')],
    [
      'an unrelated stderr',
      Object.assign(new Error('Command failed'), { stderr: 'fatal: bad object' })
    ],
    [
      'a nested unrelated cause',
      Object.assign(new Error('wrapper'), { cause: withCode('ECONNRESET') })
    ],
    ['a numeric errno', Object.assign(new Error('x'), { errno: -28 })]
  ])('is false for %s', (_name, error) => {
    expect(isDiskFullError(error)).toBe(false)
  })

  it('is false for null, undefined and non-objects, even when a string carries the phrase', () => {
    expect(isDiskFullError(null)).toBe(false)
    expect(isDiskFullError(undefined)).toBe(false)
    expect(isDiskFullError(42)).toBe(false)
    expect(isDiskFullError('space')).toBe(false)
    expect(isDiskFullError('No space left on device')).toBe(false)
  })

  it('reads only one level of cause and survives a cyclic cause', () => {
    const deep = Object.assign(new Error('a'), {
      cause: Object.assign(new Error('b'), { cause: withCode('ENOSPC') })
    })
    expect(isDiskFullError(deep)).toBe(false)
    const cyclic = new Error('loop') as Error & { cause?: unknown }
    cyclic.cause = cyclic
    expect(isDiskFullError(cyclic)).toBe(false)
  })
})
