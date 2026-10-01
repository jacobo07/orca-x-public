import { describe, expect, it } from 'vitest'
import { create } from 'zustand'
import { createSshSlice, type SshSlice } from './ssh'
import { createTestStore } from './store-test-helpers'

function makeStore() {
  return create<SshSlice>()((...args) =>
    createSshSlice(...(args as Parameters<typeof createSshSlice>))
  )
}

const request = (requestId: string) => ({
  requestId,
  targetId: 'ssh-1',
  label: 'Build box',
  host: '10.0.0.5',
  port: 22,
  offeredFingerprint: 'SHA256:OFFEREDOFFEREDOFFEREDOFFEREDOFFEREDOFFEREDOFF'
})

describe('ssh host key trust queue', () => {
  it('queues requests in arrival order and removes exactly the answered one', () => {
    const store = makeStore()

    store.getState().enqueueSshHostKeyTrustRequest(request('a'))
    store.getState().enqueueSshHostKeyTrustRequest(request('b'))
    expect(store.getState().sshHostKeyTrustQueue.map((r) => r.requestId)).toEqual(['a', 'b'])

    store.getState().removeSshHostKeyTrustRequest('a')
    expect(store.getState().sshHostKeyTrustQueue.map((r) => r.requestId)).toEqual(['b'])
  })

  it('keeps the trust queue separate from the credential queue', () => {
    const store = makeStore()

    store.getState().enqueueSshHostKeyTrustRequest(request('a'))

    expect(store.getState().sshCredentialQueue).toEqual([])
  })
  it('drops the pending trust requests of a removed target and keeps the others', () => {
    const store = createTestStore()
    store.getState().enqueueSshHostKeyTrustRequest(request('a'))
    store.getState().enqueueSshHostKeyTrustRequest({ ...request('b'), targetId: 'ssh-2' })

    store.getState().clearRemovedSshTargetState('ssh-1')

    expect(store.getState().sshHostKeyTrustQueue.map((r) => r.requestId)).toEqual(['b'])
  })
})
