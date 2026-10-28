import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  probeSshRelayCapabilities,
  relaySupportsReplicaBundle,
  requestGatedRelayMethod,
  RelayCapabilityUnsupportedError,
  requiredCapabilityForMethod,
  resetSshRelayCapabilityCacheForTests
} from './ssh-relay-capabilities'

describe('probeSshRelayCapabilities', () => {
  beforeEach(resetSshRelayCapabilityCacheForTests)

  it('probes once per generation and re-probes on a bump', async () => {
    const req = vi.fn().mockResolvedValue({ capabilities: ['git.replicaBundle'] })
    await probeSshRelayCapabilities('c', 1, req)
    await probeSshRelayCapabilities('c', 1, req)
    expect(req).toHaveBeenCalledTimes(1)
    await probeSshRelayCapabilities('c', 2, req)
    expect(req).toHaveBeenCalledTimes(2)
  })

  it('an old relay without the capability reads unsupported', async () => {
    const req = vi.fn().mockResolvedValue({ capabilities: ['git.exec'] })
    expect(await relaySupportsReplicaBundle('c', 1, req)).toBe(false)
  })

  it('a non-array answer is no capabilities', async () => {
    const req = vi.fn().mockResolvedValue({ capabilities: 'git.replicaBundle' })
    expect(await probeSshRelayCapabilities('c', 1, req)).toEqual([])
  })

  it('a failed probe is not cached', async () => {
    const req = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ capabilities: ['git.replicaBundle'] })
    await expect(probeSshRelayCapabilities('c', 1, req)).rejects.toThrow('boom')
    expect(await relaySupportsReplicaBundle('c', 1, req)).toBe(true)
  })
})

describe('requestGatedRelayMethod (mixed relay versions fail closed)', () => {
  beforeEach(resetSshRelayCapabilityCacheForTests)
  const opts = { timeoutMs: 1000 }
  const notFound = Object.assign(new Error('Method not found'), { code: -32601 })

  it('classifies only sync./fabric. methods', () => {
    expect(requiredCapabilityForMethod('sync.push')).toBe('sync.v1')
    expect(requiredCapabilityForMethod('fabric.open')).toBe('fabric.v1')
    expect(requiredCapabilityForMethod('git.exec')).toBeNull()
  })

  it('old relay without the capability: method is never sent', async () => {
    const req = vi.fn(async (m: string) => (m === 'relay.status' ? { capabilities: ['git.exec'] } : 1))
    await expect(requestGatedRelayMethod('c', 1, req, 'sync.push', {}, opts)).rejects.toBeInstanceOf(
      RelayCapabilityUnsupportedError
    )
    expect(req.mock.calls.map((c) => c[0])).toEqual(['relay.status'])
  })

  it('relay too old for relay.status: fails closed', async () => {
    const req = vi.fn().mockRejectedValue(notFound)
    await expect(requestGatedRelayMethod('c', 1, req, 'fabric.x', {}, opts)).rejects.toBeInstanceOf(
      RelayCapabilityUnsupportedError
    )
    expect(req).toHaveBeenCalledTimes(1)
  })

  it('probe transport errors propagate, not widen', async () => {
    const req = vi.fn().mockRejectedValue(new Error('boom'))
    await expect(requestGatedRelayMethod('c', 1, req, 'sync.push', {}, opts)).rejects.toThrow('boom')
  })

  it('advertised capability is sent once', async () => {
    const req = vi.fn(async (m: string) => (m === 'relay.status' ? { capabilities: ['sync.v1'] } : 'ok'))
    expect(await requestGatedRelayMethod('c', 1, req, 'sync.push', { a: 1 }, opts)).toBe('ok')
    expect(req).toHaveBeenLastCalledWith('sync.push', { a: 1 }, opts)
  })

  it('MethodNotFound after an advertisement fails closed and evicts the cache', async () => {
    const req = vi.fn(async (m: string) => {
      if (m === 'relay.status') {
        return { capabilities: ['sync.v1'] }
      }
      throw notFound
    })
    await expect(requestGatedRelayMethod('c', 1, req, 'sync.push', {}, opts)).rejects.toBeInstanceOf(
      RelayCapabilityUnsupportedError
    )
    await expect(requestGatedRelayMethod('c', 1, req, 'sync.push', {}, opts)).rejects.toBeInstanceOf(
      RelayCapabilityUnsupportedError
    )
    expect(req.mock.calls.filter((c) => c[0] === 'relay.status')).toHaveLength(2)
  })

  it('ungated methods pass through without probing', async () => {
    const req = vi.fn().mockResolvedValue('x')
    expect(await requestGatedRelayMethod('c', 1, req, 'git.exec', {}, opts)).toBe('x')
    expect(req).toHaveBeenCalledTimes(1)
  })
})
