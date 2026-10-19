import { describe, expect, it } from 'vitest'
import type { ConnectionState, HostProfile } from '../transport/types'
import { switchHostPickerOptions } from './mobile-session-host-options'

function host(id: string, name: string, endpoint: string, lastConnected: number): HostProfile {
  return {
    id,
    name,
    endpoint,
    deviceToken: `token-${id}`,
    publicKeyB64: `key-${id}`,
    lastConnected
  }
}

const desk = host('desk', 'Desk', 'ws://192.168.1.2:6768', 10)
const laptop = host('laptop', 'Laptop', 'wss://relay.example.com/mobile', 30)
const server = host('server', 'Server', 'ws://10.0.0.5:6768', 20)

describe('switchHostPickerOptions', () => {
  it('orders hosts by most recent connection', () => {
    const options = switchHostPickerOptions([desk, laptop, server], new Map())
    expect(options.map((option) => option.value)).toEqual(['laptop', 'server', 'desk'])
  })

  it('puts the connection state before the endpoint', () => {
    const states = new Map<string, ConnectionState>([
      ['desk', 'connected'],
      ['laptop', 'reconnecting'],
      ['server', 'auth-failed']
    ])
    expect(switchHostPickerOptions([desk, laptop, server], states)).toEqual([
      { value: 'laptop', label: 'Laptop', subtitle: 'Reconnecting · relay.example.com' },
      { value: 'server', label: 'Server', subtitle: 'Pairing invalid · 10.0.0.5:6768' },
      { value: 'desk', label: 'Desk', subtitle: 'Connected · 192.168.1.2:6768' }
    ])
  })

  it('reads a host with no client as not connected, not as a failure', () => {
    expect(switchHostPickerOptions([desk], new Map())[0].subtitle).toBe(
      'Not connected · 192.168.1.2:6768'
    )
  })

  it('tells same-named hosts apart the way home does, without leaking endpoint paths', () => {
    const a = host('desk-a', 'Desk', 'wss://gateway.example.com/v1/connect/bearer-secret-a', 2)
    const b = host('desk-b', 'Desk', 'wss://gateway.example.com/v1/connect/bearer-secret-b', 1)
    const options = switchHostPickerOptions([a, b], new Map())
    expect(options.map((option) => option.subtitle)).toEqual([
      'Not connected · gateway.example.com · desk-a',
      'Not connected · gateway.example.com · desk-b'
    ])
    expect(JSON.stringify(options)).not.toContain('bearer-secret')
  })

  it('breaks a recency tie by id so the order is stable', () => {
    const b = host('b', 'B', 'ws://b:1', 5)
    const a = host('a', 'A', 'ws://a:1', 5)
    expect(switchHostPickerOptions([b, a], new Map()).map((option) => option.value)).toEqual([
      'a',
      'b'
    ])
  })
})
