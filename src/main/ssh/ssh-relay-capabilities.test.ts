import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  probeSshRelayCapabilities,
  relaySupportsReplicaBundle,
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
