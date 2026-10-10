import { createHash } from 'node:crypto'
import { describe, expect, it, vi, type Mock } from 'vitest'
import type { SshHostKeyPin, SshTarget } from '../../shared/ssh-types'
import { resolveSshHostIdentityStatus } from '../../shared/ssh-host-key-pin-shape'
import { SSH_HOST_KEY_REFUSED_CODE } from '../../shared/ssh-types'
import { normalizeSshTarget } from '../persistence/leasing-ssh-ptys/ssh-normalization'
import {
  addSshTarget,
  setSshTargetHostKeyPin,
  updateSshTarget,
  type SshTargetStateOperations
} from '../persistence/leasing-ssh-ptys/ssh-target-state'
import {
  SshHostKeyRefusedError,
  adoptableTrustedPin,
  computeHostKeyFingerprint,
  hostKeyVerdictAllowsConnect,
  parseHostKeyPin,
  readHostKeyAlgorithm,
  refusalFromVerdict,
  verifyHostKeyAgainstPin
} from './ssh-host-key-pin-verifier'

const KEY = Buffer.from('mock-ssh-host-key')
const FINGERPRINT = computeHostKeyFingerprint(KEY)

function pin(overrides?: Partial<SshHostKeyPin>): SshHostKeyPin {
  return {
    fingerprint: FINGERPRINT,
    host: 'example.com',
    port: 22,
    pinnedAt: 1,
    source: 'tofu-confirmed',
    ...overrides
  }
}

const offered = { fingerprint: FINGERPRINT, host: 'example.com', port: 22 }

describe('host key fingerprint', () => {
  it('V-SSH-FP-FORMAT: equals the SHA256 string the relay lock has always used', () => {
    const legacy = `SHA256:${createHash('sha256').update(KEY).digest('base64').replace(/=+$/, '')}`
    expect(FINGERPRINT).toBe(legacy)
    expect(FINGERPRINT).toMatch(/^SHA256:[A-Za-z\d+/]{43}$/)
  })

  it('reads the algorithm from the wire blob and tolerates garbage', () => {
    const name = Buffer.from('ssh-ed25519')
    const len = Buffer.alloc(4)
    len.writeUInt32BE(name.length)
    expect(readHostKeyAlgorithm(Buffer.concat([len, name, Buffer.from('rest')]))).toBe(
      'ssh-ed25519'
    )
    expect(readHostKeyAlgorithm(KEY)).toBeUndefined()
    expect(readHostKeyAlgorithm(Buffer.alloc(2))).toBeUndefined()
  })
})

describe('verifyHostKeyAgainstPin', () => {
  it('V-SSH-VERIFY-TABLE: pinned-match, changed, unpinned, unverifiable', () => {
    expect(verifyHostKeyAgainstPin(pin(), offered)).toEqual({ kind: 'pinned-match' })
    expect(
      verifyHostKeyAgainstPin(pin(), {
        ...offered,
        fingerprint: computeHostKeyFingerprint(Buffer.from('other'))
      })
    ).toEqual({ kind: 'changed', pinnedFingerprint: FINGERPRINT })
    expect(verifyHostKeyAgainstPin(undefined, offered)).toEqual({ kind: 'unpinned' })
    expect(verifyHostKeyAgainstPin(pin({ port: 2222 }), offered)).toEqual({
      kind: 'endpoint-mismatch'
    })
    expect(verifyHostKeyAgainstPin(pin({ host: 'other.example' }), offered)).toEqual({
      kind: 'endpoint-mismatch'
    })
    expect(verifyHostKeyAgainstPin(pin({ host: 'EXAMPLE.com' }), offered)).toEqual({
      kind: 'pinned-match'
    })
    for (const damaged of [
      { fingerprint: 'nope' },
      null,
      'string',
      [],
      { ...pin(), pinnedAt: undefined },
      { ...pin(), source: 'invented' },
      { ...pin(), port: 0 },
      { ...pin(), fingerprint: `${FINGERPRINT}x` }
    ]) {
      expect(verifyHostKeyAgainstPin(damaged, offered)).toEqual({ kind: 'unverifiable' })
    }
  })

  it('only a match, or an unpinned automatic attempt, may connect', () => {
    expect(hostKeyVerdictAllowsConnect({ kind: 'pinned-match' }, true)).toBe(true)
    expect(hostKeyVerdictAllowsConnect({ kind: 'pinned-match' }, false)).toBe(true)
    expect(hostKeyVerdictAllowsConnect({ kind: 'unpinned' }, false)).toBe(false)
    expect(hostKeyVerdictAllowsConnect({ kind: 'unpinned' }, true)).toBe(false)
    for (const interactive of [true, false]) {
      expect(
        hostKeyVerdictAllowsConnect(
          { kind: 'changed', pinnedFingerprint: FINGERPRINT },
          interactive
        )
      ).toBe(false)
      expect(hostKeyVerdictAllowsConnect({ kind: 'unverifiable' }, interactive)).toBe(false)
    }
  })

  it('a pin for another endpoint reads endpoint-mismatch and never connects without a person', () => {
    const verdict = verifyHostKeyAgainstPin(pin({ host: 'elsewhere.example' }), offered)
    expect(verdict).toEqual({ kind: 'endpoint-mismatch' })
    expect(hostKeyVerdictAllowsConnect(verdict, false)).toBe(false)
    expect(hostKeyVerdictAllowsConnect(verdict, true)).toBe(false)
    expect(refusalFromVerdict(verdict, offered).reason).toBe('host_key_unpinned')
  })
  it('parseHostKeyPin keeps optional fields and rejects wrong types', () => {
    expect(parseHostKeyPin(pin({ algorithm: 'ssh-ed25519', publicKeyBase64: 'AAAA' }))).toEqual(
      pin({ algorithm: 'ssh-ed25519', publicKeyBase64: 'AAAA' })
    )
    expect(parseHostKeyPin({ ...pin(), algorithm: 5 })).toBeNull()
  })

  it('adopts a trust answer only when it names exactly the offered key and was confirmed', () => {
    expect(adoptableTrustedPin(pin(), offered)).toEqual(pin())
    expect(
      adoptableTrustedPin(pin({ fingerprint: computeHostKeyFingerprint(KEY.subarray(1)) }), offered)
    ).toBeNull()
    expect(adoptableTrustedPin(pin({ source: 'manual' }), offered)).toBeNull()
    expect(adoptableTrustedPin(pin({ port: 2222 }), offered)).toBeNull()
    expect(adoptableTrustedPin(null, offered)).toBeNull()
  })

  it('SshHostKeyRefusedError carries a stable code and both fingerprints', () => {
    const err = new SshHostKeyRefusedError('host_key_changed', offered, 'SHA256:pinned')
    expect(err.code).toBe(SSH_HOST_KEY_REFUSED_CODE)
    expect(err.message).toContain('SHA256:pinned')
    expect(err.message).toContain(FINGERPRINT)
  })
})

function target(overrides?: Partial<SshTarget>): SshTarget {
  return { id: 't1', label: 'Box', host: 'example.com', port: 22, username: 'me', ...overrides }
}

function fakeOperations(sshTargets: SshTarget[]): SshTargetStateOperations & {
  flush: Mock<() => void>
  scheduleSave: Mock<() => void>
} {
  return {
    state: { sshTargets } as never,
    protectedSecrets: { removeRetainedBlob: vi.fn() } as never,
    scheduleSave: vi.fn<() => void>(),
    flush: vi.fn<() => void>()
  }
}

describe('persisted pin', () => {
  it('V-SSH-MALFORMED-REFUSED: a damaged pin survives normalize and update, and reads unverifiable', () => {
    const damaged = { fingerprint: 'nope' } as unknown as SshHostKeyPin
    const normalized = normalizeSshTarget(target({ hostKeyPin: damaged }))
    expect(normalized.hostKeyPin).toEqual(damaged)

    const ops = fakeOperations([target({ hostKeyPin: damaged })])
    const updated = updateSshTarget(ops, 't1', { label: 'Renamed' })
    expect(updated?.hostKeyPin).toEqual(damaged)
    expect(verifyHostKeyAgainstPin(updated?.hostKeyPin, offered)).toEqual({ kind: 'unverifiable' })
  })

  it('V-SSH-PIN-FLUSH: setSshTargetHostKeyPin flushes, not just schedules', () => {
    const ops = fakeOperations([target()])
    const result = setSshTargetHostKeyPin(ops, 't1', pin())
    expect(result?.hostKeyPin).toEqual(pin())
    expect(ops.flush).toHaveBeenCalledTimes(1)
    expect(setSshTargetHostKeyPin(ops, 'missing', pin())).toBeNull()
    setSshTargetHostKeyPin(ops, 't1', null)
    expect(ops.state.sshTargets?.[0]).not.toHaveProperty('hostKeyPin')
  })

  it('V-SSH-STORE-KEEPS-PIN: unrelated updates keep it, a re-point clears it, callers cannot write it', () => {
    const ops = fakeOperations([target({ hostKeyPin: pin() })])
    expect(updateSshTarget(ops, 't1', { label: 'Renamed' })?.hostKeyPin).toEqual(pin())
    expect(updateSshTarget(ops, 't1', { host: 'example.com', port: 22 })?.hostKeyPin).toEqual(pin())
    const forged = pin({ fingerprint: computeHostKeyFingerprint(Buffer.from('forged')) })
    expect(updateSshTarget(ops, 't1', { hostKeyPin: forged })?.hostKeyPin).toEqual(pin())
    expect(updateSshTarget(ops, 't1', { port: 2222 })).not.toHaveProperty('hostKeyPin')

    const repointed = fakeOperations([target({ hostKeyPin: pin() })])
    expect(updateSshTarget(repointed, 't1', { host: 'other.example' })).not.toHaveProperty(
      'hostKeyPin'
    )
  })

  it('V-SSH-PIN-RESET-MARKER: removing a pin that existed, by replace or by re-point, persists the marker', () => {
    const replaced = fakeOperations([target({ hostKeyPin: pin() })])
    setSshTargetHostKeyPin(replaced, 't1', null)
    expect(replaced.state.sshTargets?.[0]).toMatchObject({ hostKeyPinReset: true })
    expect(replaced.state.sshTargets?.[0]).not.toHaveProperty('hostKeyPin')

    const repointed = fakeOperations([target({ hostKeyPin: pin() })])
    expect(updateSshTarget(repointed, 't1', { port: 2222 })).toMatchObject({ hostKeyPinReset: true })
    // the marker survives an unrelated edit and a reload through normalization
    expect(updateSshTarget(repointed, 't1', { label: 'Renamed' })).toMatchObject({
      hostKeyPinReset: true
    })
    expect(normalizeSshTarget(repointed.state.sshTargets![0]!)).toMatchObject({
      hostKeyPinReset: true
    })
  })

  it('V-SSH-PIN-RESET-LEGACY: a never-pinned target keeps no marker through clear, re-point or add', () => {
    const ops = fakeOperations([target()])
    setSshTargetHostKeyPin(ops, 't1', null)
    expect(updateSshTarget(ops, 't1', { port: 2222 })).not.toHaveProperty('hostKeyPinReset')
    expect(ops.state.sshTargets?.[0]).not.toHaveProperty('hostKeyPinReset')
  })

  it('V-SSH-PIN-RESET-CLEARED-BY-PIN: writing a pin clears the marker, and callers cannot forge or clear it', () => {
    const ops = fakeOperations([target({ hostKeyPinReset: true })])
    expect(updateSshTarget(ops, 't1', { hostKeyPinReset: undefined })).toMatchObject({
      hostKeyPinReset: true
    })
    const cleared = setSshTargetHostKeyPin(ops, 't1', pin())
    expect(cleared?.hostKeyPin).toEqual(pin())
    expect(cleared).not.toHaveProperty('hostKeyPinReset')

    const added = fakeOperations([])
    addSshTarget(added, target({ hostKeyPinReset: true }))
    expect(added.state.sshTargets?.[0]).not.toHaveProperty('hostKeyPinReset')
    expect(normalizeSshTarget(target({ hostKeyPin: pin(), hostKeyPinReset: true }))).not.toHaveProperty(
      'hostKeyPinReset'
    )
  })

  it('V-SSH-PIN-RESET-VERDICT: a reset target refuses unpinned automatically, prompts interactively, and never reads verified', () => {
    expect(hostKeyVerdictAllowsConnect({ kind: 'unpinned' }, false, true)).toBe(false)
    expect(hostKeyVerdictAllowsConnect({ kind: 'unpinned' }, true, true)).toBe(false)
    expect(hostKeyVerdictAllowsConnect({ kind: 'unpinned' }, false, false)).toBe(false)
    expect(hostKeyVerdictAllowsConnect({ kind: 'pinned-match' }, false, true)).toBe(true)
    const resetTarget = target({ hostKeyPinReset: true })
    expect(resolveSshHostIdentityStatus(resetTarget, undefined)).not.toBe('pinned')
    expect(resolveSshHostIdentityStatus(resetTarget, 'refused-unpinned')).toBe('refused-unpinned')
  })

  it('a generic add never persists a pin', () => {
    const ops = fakeOperations([])
    addSshTarget(ops, target({ hostKeyPin: pin() }))
    expect(ops.state.sshTargets?.[0]).not.toHaveProperty('hostKeyPin')
  })
})
