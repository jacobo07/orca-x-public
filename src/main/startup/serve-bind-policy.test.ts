import { describe, expect, it } from 'vitest'

import { resolveServeBindPolicy } from './serve-bind-policy'

// D1 (docs/dws/d1-serve-bind-default-spec.md): `orca serve` binds only what it advertises.

const localAddresses = ['127.0.0.1', '::1', '192.168.1.40', '100.64.1.20']

describe('resolveServeBindPolicy', () => {
  it('keeps the desktop rule when nothing is advertised: the offer already says 127.0.0.1', () => {
    expect(
      resolveServeBindPolicy({ bindHost: null, pairingAddress: null, localAddresses })
    ).toEqual({ exposeNetworkByDefault: false })
  })

  it('pins the advertised IP when a local interface holds it, so a later pairing cannot widen it', () => {
    expect(
      resolveServeBindPolicy({ bindHost: null, pairingAddress: '100.64.1.20', localAddresses })
    ).toEqual({ exposeNetworkByDefault: true, pinnedBindHost: '100.64.1.20' })
  })

  it('reads the host out of an advertised host:port', () => {
    expect(
      resolveServeBindPolicy({
        bindHost: null,
        pairingAddress: '192.168.1.40:6768',
        localAddresses
      })
    ).toEqual({ exposeNetworkByDefault: true, pinnedBindHost: '192.168.1.40' })
  })

  it('pins loopback for an SSH-tunnel setup that advertises 127.0.0.1', () => {
    expect(
      resolveServeBindPolicy({ bindHost: null, pairingAddress: '127.0.0.1', localAddresses })
    ).toEqual({ exposeNetworkByDefault: true, pinnedBindHost: '127.0.0.1' })
  })

  it('pins localhost, which advertises loopback though it is not an IP literal', () => {
    for (const pairingAddress of ['localhost', 'localhost:6768']) {
      expect(resolveServeBindPolicy({ bindHost: null, pairingAddress, localAddresses })).toEqual({
        exposeNetworkByDefault: true,
        pinnedBindHost: 'localhost'
      })
    }
  })

  it('stays wide for an IP no interface holds (NAT): binding it would fail to start', () => {
    expect(
      resolveServeBindPolicy({ bindHost: null, pairingAddress: '203.0.113.9', localAddresses })
    ).toEqual({ exposeNetworkByDefault: true })
  })

  it('stays wide for a hostname or proxy URL, which maps to no single interface', () => {
    for (const pairingAddress of ['orca.example.com', 'https://orca.example.com/runtime']) {
      expect(resolveServeBindPolicy({ bindHost: null, pairingAddress, localAddresses })).toEqual({
        exposeNetworkByDefault: true
      })
    }
  })

  it('lets an explicit --bind-host outrank everything', () => {
    expect(
      resolveServeBindPolicy({ bindHost: '0.0.0.0', pairingAddress: '100.64.1.20', localAddresses })
    ).toEqual({ exposeNetworkByDefault: true, pinnedBindHost: '0.0.0.0' })
  })
})
