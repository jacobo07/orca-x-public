import { describe, expect, it } from 'vitest'
import en from '../../i18n/locales/en.json'

// Transport words and status codes that must never reach a person through backlog.* copy.
const FORBIDDEN: readonly RegExp[] = [
  /\b[1-5]\d{2}\b/,
  /Error:/,
  /ECONN/,
  /ETIMEDOUT/,
  /\bundefined\b/i,
  /\bnull\b/i,
  /\bstack\b/i,
  /\bexception\b/i
]

function strings(node: unknown, path: string, out: [string, string][]): [string, string][] {
  if (typeof node === 'string') {
    out.push([path, node])
  } else if (node && typeof node === 'object') {
    for (const [key, child] of Object.entries(node)) {
      strings(child, `${path}.${key}`, out)
    }
  }
  return out
}

function offending(text: string): RegExp | undefined {
  return FORBIDDEN.find((pattern) => pattern.test(text))
}

describe('backlog product copy', () => {
  it('carries no status code, transport phrase or raw value in any backlog.* string', () => {
    const copy = strings((en as Record<string, unknown>).backlog, 'backlog', [])
    // Floor: a walk that found nothing would pass vacuously.
    expect(copy.length).toBeGreaterThan(80)
    const hits = copy.filter(([, text]) => offending(text)).map(([path, text]) => `${path}: ${text}`)
    expect(hits).toEqual([])
  })

  it('the detector catches each forbidden shape and passes ordinary copy', () => {
    for (const bad of [
      'Failed with 503',
      'Error: disk',
      'ECONNREFUSED',
      'ETIMEDOUT while reading',
      'value was undefined',
      'got null',
      'see stack',
      'an Exception happened'
    ]) {
      expect(offending(bad), bad).toBeDefined()
    }
    expect(offending('Text is over the 20,000-character limit')).toBeUndefined()
    expect(offending('Backlog could not be read')).toBeUndefined()
  })
})
