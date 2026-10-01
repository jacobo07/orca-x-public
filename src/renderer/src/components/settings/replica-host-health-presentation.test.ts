import { describe, expect, it } from 'vitest'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'
import {
  describeReplicaHostHealth,
  isReplicaHostHealthy,
  type ReplicaHostHealthState
} from './replica-host-health-presentation'

describe('describeReplicaHostHealth', () => {
  it('reads the local host as this-host', () => {
    expect(describeReplicaHostHealth({ hostKind: 'local' })).toMatchObject({
      state: 'this-host',
      tone: 'healthy'
    })
  })

  it.each<[SshConnectionStatus, ReplicaHostHealthState]>([
    ['connected', 'reachable'],
    ['connecting', 'connecting'],
    ['deploying-relay', 'connecting'],
    ['reconnecting', 'connecting'],
    ['disconnected', 'unreachable'],
    ['auth-failed', 'unreachable'],
    ['reconnection-failed', 'unreachable'],
    ['error', 'unreachable']
  ])('maps the direct SSH status %s to %s', (status, state) => {
    expect(describeReplicaHostHealth({ hostKind: 'ssh', status }).state).toBe(state)
  })

  it('reads a direct SSH host with no connection entry as unknown, never reachable', () => {
    const health = describeReplicaHostHealth({ hostKind: 'ssh', status: undefined })

    expect(health).toMatchObject({ state: 'unknown', tone: 'unknown', label: 'Unknown' })
  })

  it('reads a host id the renderer cannot parse as unknown', () => {
    expect(describeReplicaHostHealth({ hostKind: 'unrecognized' }).state).toBe('unknown')
  })

  describe('runtime-owned rows', () => {
    const owned = (
      overrides: Partial<{
        ownerReachable: boolean
        workspaceWindowClosed: boolean
        nestedSshStatus: SshConnectionStatus | null | undefined
      }>
    ) =>
      describeReplicaHostHealth({
        hostKind: 'runtime-owned',
        ownerReachable: true,
        workspaceWindowClosed: false,
        nestedSshStatus: undefined,
        ...overrides
      }).state

    it('is unreachable when the owner is unreachable', () => {
      expect(owned({ ownerReachable: false })).toBe('unreachable')
    })

    it('is unreachable when the owner is reachable but its workspace window is closed', () => {
      expect(owned({ workspaceWindowClosed: true })).toBe('unreachable')
    })

    it('says the window is closed rather than calling a reachable server disconnected', () => {
      const health = describeReplicaHostHealth({
        hostKind: 'runtime-owned',
        ownerReachable: true,
        workspaceWindowClosed: true,
        nestedSshStatus: undefined
      })

      expect(health).toMatchObject({ state: 'unreachable', label: 'Workspace window closed' })
    })

    it('is unknown when the owner could not report the nested SSH state', () => {
      expect(owned({ nestedSshStatus: null })).toBe('unknown')
    })

    it('is unreachable when the nested SSH host is not connected', () => {
      expect(owned({ nestedSshStatus: 'disconnected' })).toBe('unreachable')
      expect(owned({ nestedSshStatus: 'connecting' })).toBe('unreachable')
    })

    it('is reachable when the owner is reachable and the nested host is connected or absent', () => {
      expect(owned({ nestedSshStatus: 'connected' })).toBe('reachable')
      expect(owned({ nestedSshStatus: undefined })).toBe('reachable')
    })
  })

  it('lets only this-host and reachable count as healthy', () => {
    const states: ReplicaHostHealthState[] = [
      'this-host',
      'reachable',
      'connecting',
      'unreachable',
      'unknown'
    ]

    expect(states.filter(isReplicaHostHealthy)).toEqual(['this-host', 'reachable'])
  })

  it('gives every state a distinct, non-empty word so colour is never the only carrier', () => {
    const labels = [
      describeReplicaHostHealth({ hostKind: 'local' }).label,
      describeReplicaHostHealth({ hostKind: 'ssh', status: 'connected' }).label,
      describeReplicaHostHealth({ hostKind: 'ssh', status: 'connecting' }).label,
      describeReplicaHostHealth({ hostKind: 'ssh', status: 'error' }).label,
      describeReplicaHostHealth({ hostKind: 'ssh', status: undefined }).label
    ]

    expect(new Set(labels).size).toBe(5)
    expect(labels.every((label) => label.length > 0)).toBe(true)
  })
})
