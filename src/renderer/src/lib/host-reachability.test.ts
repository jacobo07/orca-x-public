import { describe, expect, it } from 'vitest'
import { HOST_REACHABILITIES, deriveHostReachability, hostVouches } from './host-reachability'

describe('deriveHostReachability (workspace-workstation.md §2)', () => {
  it.each([
    ['local is this machine', { kind: 'local', health: 'local' }, 'this-machine'],
    [
      'ssh connected is reachable',
      { kind: 'ssh', health: 'available', connectionStatus: 'connected' },
      'reachable'
    ],
    ['ssh never observed is unknown', { kind: 'ssh', health: 'disconnected' }, 'unknown'],
    [
      'ssh disconnected is unknown, not down',
      { kind: 'ssh', health: 'disconnected', connectionStatus: 'disconnected' },
      'unknown'
    ],
    [
      'ssh connecting',
      { kind: 'ssh', health: 'connecting', connectionStatus: 'deploying-relay' },
      'connecting'
    ],
    [
      'ssh auth failed',
      { kind: 'ssh', health: 'error', connectionStatus: 'auth-failed' },
      'failed'
    ],
    [
      'ssh reconnection failed',
      { kind: 'ssh', health: 'error', connectionStatus: 'reconnection-failed' },
      'failed'
    ],
    ['runtime with a live status', { kind: 'runtime', health: 'available' }, 'reachable'],
    ['runtime never probed is unknown', { kind: 'runtime', health: 'disconnected' }, 'unknown'],
    ['runtime error', { kind: 'runtime', health: 'error' }, 'failed'],
    ['runtime version skew', { kind: 'runtime', health: 'blocked' }, 'blocked']
  ] as const)('%s', (_name, input, expected) => {
    expect(deriveHostReachability(input)).toBe(expected)
  })

  it('reads the observation, not the health: an SSH host is reachable only by its status', () => {
    // Control pair differing only in connectionStatus.
    expect(
      deriveHostReachability({ kind: 'ssh', health: 'available', connectionStatus: 'connected' })
    ).toBe('reachable')
    expect(deriveHostReachability({ kind: 'ssh', health: 'available' })).toBe('unknown')
  })

  it('only an observed host vouches for what runs on it', () => {
    expect(HOST_REACHABILITIES.filter(hostVouches)).toEqual(['this-machine', 'reachable'])
  })
})
