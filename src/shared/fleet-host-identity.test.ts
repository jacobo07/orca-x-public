import { describe, expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID, toRuntimeExecutionHostId } from './execution-host'
import { groupFleetHostsByIdentity, identityFromKeyFingerprint } from './fleet-host-identity'

describe('fleet host identity', () => {
  it('keys a host only from a fingerprinted key, and keeps absent apart from unreadable', () => {
    expect(identityFromKeyFingerprint('fp-a')).toEqual({ state: 'keyed', fingerprint: 'fp-a' })
    expect(identityFromKeyFingerprint(undefined)).toEqual({
      state: 'unavailable',
      reason: 'no-key'
    })
    expect(identityFromKeyFingerprint(null)).toEqual({
      state: 'unavailable',
      reason: 'key-unreadable'
    })
  })

  it('collapses two addresses of one key into one host, and keeps unkeyed addresses apart', () => {
    const runtimeSelf = toRuntimeExecutionHostId('self-served')
    const runtimeOther = toRuntimeExecutionHostId('vps')
    const unkeyedA = toRuntimeExecutionHostId('broken-a')
    const unkeyedB = toRuntimeExecutionHostId('broken-b')
    const groups = groupFleetHostsByIdentity([
      { address: runtimeSelf, identity: { state: 'keyed', fingerprint: 'fp-local' } },
      { address: runtimeOther, identity: { state: 'keyed', fingerprint: 'fp-vps' } },
      { address: LOCAL_EXECUTION_HOST_ID, identity: { state: 'keyed', fingerprint: 'fp-local' } },
      { address: unkeyedB, identity: { state: 'unavailable', reason: 'no-key' } },
      { address: unkeyedA, identity: { state: 'unavailable', reason: 'no-key' } }
    ])

    expect(groups.map((group) => [group.key, group.addresses])).toEqual([
      ['fingerprint:fp-local', [LOCAL_EXECUTION_HOST_ID, runtimeSelf]],
      ['fingerprint:fp-vps', [runtimeOther]],
      [`address:${unkeyedA}`, [unkeyedA]],
      [`address:${unkeyedB}`, [unkeyedB]]
    ])
    expect(groups[0].fingerprint).toBe('fp-local')
    expect(groups[2].fingerprint).toBeNull()
  })

  it('never merges two unkeyed addresses even when both are unreadable', () => {
    const groups = groupFleetHostsByIdentity([
      {
        address: toRuntimeExecutionHostId('a'),
        identity: { state: 'unavailable', reason: 'key-unreadable' }
      },
      {
        address: toRuntimeExecutionHostId('b'),
        identity: { state: 'unavailable', reason: 'key-unreadable' }
      }
    ])
    expect(groups).toHaveLength(2)
  })

  it('orders groups identically regardless of input order', () => {
    const entries = [
      { address: toRuntimeExecutionHostId('z'), identity: { state: 'keyed', fingerprint: 'fp-z' } },
      { address: toRuntimeExecutionHostId('a'), identity: { state: 'keyed', fingerprint: 'fp-a' } },
      { address: LOCAL_EXECUTION_HOST_ID, identity: { state: 'keyed', fingerprint: 'fp-m' } }
    ] as const
    const forward = groupFleetHostsByIdentity([...entries])
    const reversed = groupFleetHostsByIdentity(entries.toReversed())
    expect(reversed).toEqual(forward)
  })
})
