import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { deriveHarvestFingerprint, normalizeIntentForFingerprint } from './candidate-fingerprint'

describe('harvest candidate fingerprint', () => {
  it('normalizes case, whitespace and trailing punctuation to one fingerprint', () => {
    const noisy = deriveHarvestFingerprint('orca-conversation', 'c#m#L0', 'Ship  the Inbox.')
    const clean = deriveHarvestFingerprint('orca-conversation', 'c#m#L0', 'ship the inbox')
    expect(noisy).toBe(clean)
    expect(noisy).toMatch(/^[0-9a-f]{64}$/)
    expect(noisy.includes('\0')).toBe(false)
  })

  it('puts the ref and the kind in the identity: same text, different subject, different hash', () => {
    const base = deriveHarvestFingerprint('orca-conversation', 'c#m#L0', 'ship the inbox')
    expect(deriveHarvestFingerprint('orca-conversation', 'c#m#L1', 'ship the inbox')).not.toBe(base)
    expect(deriveHarvestFingerprint('codex-transcript', 'c#m#L0', 'ship the inbox')).not.toBe(base)
    expect(deriveHarvestFingerprint('orca-conversation', 'c#m#L0', 'ship the outbox')).not.toBe(
      base
    )
  })

  it('hashes exactly kind NUL ref NUL normalized text', () => {
    const expected = createHash('sha256')
      .update('orca-conversation\0c#m#L0\0ship the inbox')
      .digest('hex')
    expect(deriveHarvestFingerprint('orca-conversation', 'c#m#L0', '  Ship the inbox!?  ')).toBe(
      expected
    )
  })

  it('composes NFC and keeps accents, so distinct Spanish words stay distinct', () => {
    const decomposed = 'Próximo paso'
    expect(normalizeIntentForFingerprint(decomposed)).toBe('próximo paso')
    expect(normalizeIntentForFingerprint('Próximo paso…')).toBe('próximo paso')
    expect(normalizeIntentForFingerprint('Proximo paso')).toBe('proximo paso')
    expect(normalizeIntentForFingerprint('a\t\n b ; ')).toBe('a b')
  })
})
