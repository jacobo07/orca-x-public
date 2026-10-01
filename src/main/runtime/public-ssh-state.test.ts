import { describe, expect, it } from 'vitest'
import { SSH_HOST_KEY_REFUSED_CODE } from '../../shared/ssh-types'
import type { SshConnectionState, SshProviderEpoch } from '../../shared/ssh-types'
import { getHostKeyRefusalReason, getPublicSshError, getPublicSshState } from './public-ssh-state'

describe('public SSH state', () => {
  it('preserves the complete provider authority pair', () => {
    const state: SshConnectionState = {
      targetId: 'ssh-a',
      status: 'error',
      error: 'private detail',
      reconnectAttempt: 0,
      providerEpoch: 'provider-a' as SshProviderEpoch,
      connectionGeneration: 3
    }

    expect(getPublicSshState(state)).toEqual({
      ...state,
      error: 'SSH connection unavailable'
    })
  })

  it('V-SSH-PUBLIC-HOST-KEY: a refused host key gets its own actionable message without fingerprints', () => {
    const fingerprint = 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    const changed = getPublicSshState({
      targetId: 'ssh-a',
      status: 'error',
      error: `Host key for hub.internal:22 changed: pinned ${fingerprint}, offered ${fingerprint}.`,
      reconnectAttempt: 0,
      hostIdentity: 'refused-changed'
    })
    expect(changed?.error).toMatch(/host key changed/i)
    expect(changed?.error).not.toContain('SHA256')
    expect(changed?.error).not.toContain('hub.internal')
    expect(changed?.error).not.toBe('SSH connection unavailable')

    const unpinned = getPublicSshState({
      targetId: 'ssh-a',
      status: 'error',
      error: 'private',
      reconnectAttempt: 0,
      hostIdentity: 'refused-unpinned'
    })
    expect(unpinned?.error).toMatch(/not trusted yet/i)
  })

  it('V-SSH-REFUSAL-COPY-REACHABLE: no refusal text promises a re-pin, which no UI can perform', () => {
    for (const hostIdentity of ['refused-changed', 'refused-unpinned', 'unverifiable'] as const) {
      const error = getPublicSshState({
        targetId: 'ssh-a',
        status: 'error',
        error: 'private',
        reconnectAttempt: 0,
        hostIdentity
      })?.error
      expect(error).not.toMatch(/re-?pin/i)
    }
    const changed = getPublicSshState({
      targetId: 'ssh-a',
      status: 'error',
      error: 'private',
      reconnectAttempt: 0,
      hostIdentity: 'refused-changed'
    })?.error
    expect(changed).toMatch(/remove this SSH target.*add it again/i)
  })

  it('leaves a generic outage, and a healthy identity, unchanged', () => {
    const outage = getPublicSshState({
      targetId: 'ssh-a',
      status: 'error',
      error: 'connect ECONNREFUSED 10.0.0.1:22',
      reconnectAttempt: 0,
      hostIdentity: 'pinned'
    })
    expect(outage?.error).toBe('SSH connection unavailable')
    expect(getPublicSshError('auth-failed')).toBe('SSH authentication failed')
    expect(getPublicSshError('error')).toBe('SSH connection unavailable')
  })

  it('reads a refusal from a thrown error by its stable code, not its message', () => {
    const thrown = Object.assign(new Error('anything'), {
      code: SSH_HOST_KEY_REFUSED_CODE,
      reason: 'host_key_changed'
    })
    expect(getHostKeyRefusalReason(thrown)).toBe('host_key_changed')
    expect(getHostKeyRefusalReason(new Error('anything'))).toBeUndefined()
    expect(
      getHostKeyRefusalReason(Object.assign(new Error('x'), { code: 'EOTHER' }))
    ).toBeUndefined()
    expect(getHostKeyRefusalReason(undefined, 'unverifiable')).toBe('host_key_unverifiable')
  })
})
