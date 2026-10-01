import { describe, expect, it } from 'vitest'
import { parseHostKeyPin, resolveSshHostIdentityStatus } from './ssh-host-key-pin-shape'
import type { SshHostKeyPin } from './ssh-types'

const PIN: SshHostKeyPin = {
  fingerprint: `SHA256:${'B'.repeat(43)}`,
  host: 'Build.Example',
  port: 22,
  pinnedAt: 1,
  source: 'tofu-confirmed'
}
const target = (hostKeyPin?: unknown) => ({ host: 'build.example', port: 22, hostKeyPin })

describe('resolveSshHostIdentityStatus', () => {
  it('reads a valid pin as pinned and no pin as unpinned', () => {
    expect(resolveSshHostIdentityStatus(target(PIN), undefined)).toBe('pinned')
    expect(resolveSshHostIdentityStatus(target(undefined), undefined)).toBe('unpinned-legacy')
  })

  it('V-FLEET-DELEGATED: delegation outranks a valid pin', () => {
    expect(resolveSshHostIdentityStatus(target(PIN), 'delegated-to-openssh')).toBe(
      'delegated-to-openssh'
    )
    expect(resolveSshHostIdentityStatus(target(undefined), 'delegated-to-openssh')).toBe(
      'delegated-to-openssh'
    )
  })

  it('never shows verified for a damaged pin, whatever the live state says', () => {
    for (const damaged of [null, {}, { ...PIN, fingerprint: 'SHA256:short' }, 'x']) {
      expect(parseHostKeyPin(damaged)).toBeNull()
      expect(resolveSshHostIdentityStatus(target(damaged), 'pinned')).toBe('unverifiable')
    }
  })

  it('never shows verified for a pin recorded for a different endpoint', () => {
    expect(resolveSshHostIdentityStatus({ ...target(PIN), port: 2222 }, 'pinned')).toBe(
      'refused-unpinned'
    )
    expect(resolveSshHostIdentityStatus({ ...target(PIN), host: 'other' }, undefined)).toBe(
      'refused-unpinned'
    )
  })

  it('lets a live refusal or unpinned verdict override a saved valid pin', () => {
    expect(resolveSshHostIdentityStatus(target(PIN), 'refused-changed')).toBe('refused-changed')
    expect(resolveSshHostIdentityStatus(target(PIN), 'unpinned-legacy')).toBe('unpinned-legacy')
  })

  it('ignores a stale live pinned or refused-changed once the pin is gone', () => {
    expect(resolveSshHostIdentityStatus(target(undefined), 'pinned')).toBe('unpinned-legacy')
    expect(resolveSshHostIdentityStatus(target(undefined), 'refused-changed')).toBe(
      'unpinned-legacy'
    )
    expect(resolveSshHostIdentityStatus(target(undefined), 'refused-unpinned')).toBe(
      'refused-unpinned'
    )
  })
})
