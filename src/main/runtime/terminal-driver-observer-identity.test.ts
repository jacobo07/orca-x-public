import { describe, expect, it } from 'vitest'
import { fingerprintAuthenticatedPairingCredential } from './rpc/orchestration-mutation-executor'
import { observedTerminalDriverState } from './terminal-driver-observer-identity'

const TOKEN = 'e5'.repeat(24)

describe('observedTerminalDriverState', () => {
  it('replaces a mobile credential with a stable per-device id', () => {
    const observed = observedTerminalDriverState({ kind: 'mobile', clientId: TOKEN })

    expect(observed).toEqual({
      kind: 'mobile',
      clientId: expect.stringMatching(/^observed:[0-9a-f]{32}$/)
    })
    expect(observedTerminalDriverState({ kind: 'mobile', clientId: TOKEN })).toEqual(observed)
    expect(observedTerminalDriverState({ kind: 'mobile', clientId: 'f6'.repeat(24) })).not.toEqual(
      observed
    )
  })

  it('is idempotent, so two egress layers cannot re-hash into a different id', () => {
    const once = observedTerminalDriverState({ kind: 'mobile', clientId: TOKEN })
    expect(observedTerminalDriverState(once)).toEqual(once)
  })

  it('is not the federation caller fingerprint, which is an ownership key', () => {
    const observed = observedTerminalDriverState({ kind: 'mobile', clientId: TOKEN })
    const fingerprint = fingerprintAuthenticatedPairingCredential(TOKEN)
    expect(observed.kind === 'mobile' && fingerprint.includes(observed.clientId.slice(9))).toBe(
      false
    )
  })

  it('passes non-mobile drivers through', () => {
    expect(observedTerminalDriverState({ kind: 'idle' })).toEqual({ kind: 'idle' })
    expect(observedTerminalDriverState({ kind: 'desktop' })).toEqual({ kind: 'desktop' })
  })
})
