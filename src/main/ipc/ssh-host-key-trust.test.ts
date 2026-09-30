import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = await vi.hoisted(async () => {
  const { createSshIpcMocks } = await import('./ssh-ipc-module-mocks')
  return createSshIpcMocks()
})

vi.mock('../ssh/ssh-config-host-picker', () => mocks.sshConfigHostPicker)
vi.mock('electron', () => mocks.electron)
vi.mock('./ssh-pty-output-intake-registry', () => mocks.sshPtyOutputIntakeRegistry)
vi.mock('../ssh/ssh-connection-store', () => mocks.sshConnectionStore)
vi.mock('../ssh/ssh-connection-manager', () => mocks.sshConnectionManager)
vi.mock('../ssh/ssh-relay-deploy', () => mocks.sshRelayDeploy)
vi.mock('../ssh/ssh-relay-reset', () => mocks.sshRelayReset)
vi.mock('../ssh/ssh-channel-multiplexer', () => mocks.sshChannelMultiplexer)
vi.mock('../providers/ssh-pty-provider', () => mocks.sshPtyProvider)
vi.mock('../providers/ssh-filesystem-provider', () => mocks.sshFilesystemProvider)
vi.mock('./pty', () => mocks.pty)
vi.mock('../providers/ssh-filesystem-dispatch', () => mocks.sshFilesystemDispatch)
vi.mock('../providers/ssh-git-provider', () => mocks.sshGitProvider)
vi.mock('../providers/ssh-git-dispatch', () => mocks.sshGitDispatch)
vi.mock('../ssh/ssh-port-forward', () => mocks.sshPortForward)
vi.mock('../ssh/ssh-port-scanner', () => mocks.sshPortScanner)

import type { SshConnectionState, SshHostKeyPin, SshTarget } from '../../shared/ssh-types'
import type { SshConnectionCallbacks } from '../ssh/ssh-connection-utils'
import { SshHostKeyRefusedError } from '../ssh/ssh-host-key-pin-verifier'
import { connectRegisteredSshTarget } from './ssh'
import { createSshIpcHarness } from './ssh-ipc-test-harness'

const { mockSshStore, mockConnectionManager } = mocks

const OFFERED_FP = 'SHA256:OFFEREDOFFEREDOFFEREDOFFEREDOFFEREDOFFEREDOFF'
const PINNED_FP = 'SHA256:PINNEDPINNEDPINNEDPINNEDPINNEDPINNEDPINNEDPIN'

const TARGET: SshTarget = {
  id: 'ssh-1',
  label: 'Build box',
  host: '10.0.0.5',
  port: 22,
  username: 'deploy'
}

const CONNECTED: SshConnectionState = {
  targetId: 'ssh-1',
  status: 'connected',
  error: null,
  reconnectAttempt: 0
}

const OFFERED = {
  host: '10.0.0.5',
  port: 22,
  fingerprint: OFFERED_FP,
  algorithm: 'ssh-ed25519',
  publicKeyBase64: 'AAAAC3NzaC1lZDI1NTE5'
}

describe('SSH host key trust IPC', () => {
  const harness = createSshIpcHarness(mocks)
  const { handlers, mockWindow } = harness

  beforeEach(async () => {
    await harness.reset()
    mockSshStore.getTarget.mockReturnValue(TARGET)
    mockSshStore.setHostKeyPin.mockImplementation((_id: string, pin: SshHostKeyPin | null) => ({
      ...TARGET,
      ...(pin ? { hostKeyPin: pin } : {})
    }))
    mockConnectionManager.getState.mockReturnValue(CONNECTED)
  })

  const callbacks = (): SshConnectionCallbacks =>
    mockConnectionManager.callbacksRef.current as SshConnectionCallbacks

  const trustRequests = (): { requestId: string; [key: string]: unknown }[] =>
    mockWindow.webContents.send.mock.calls
      .filter(([channel]) => channel === 'ssh:host-key-trust-request')
      .map(([, payload]) => payload as { requestId: string })

  const answerLatestTrustRequest = (answer: Record<string, unknown>): void => {
    const request = trustRequests().at(-1)!
    handlers.get('ssh:submitHostKeyTrust')!(null, { requestId: request.requestId, ...answer })
  }

  const stateBroadcasts = (): SshConnectionState[] =>
    mockWindow.webContents.send.mock.calls
      .filter(([channel]) => channel === 'ssh:state-changed')
      .map(([, payload]) => (payload as { state: SshConnectionState }).state)

  it('V-IPC-TOFU-PINS: a Trust answer is flushed as a tofu-confirmed pin before the callback resolves', async () => {
    let pinCallsWhenCallbackResolved = -1
    let returnedPin: SshHostKeyPin | null = null
    mockConnectionManager.connect.mockImplementation(async (target: SshTarget) => {
      const pending = callbacks().onHostKeyTrustRequest!(target.id, OFFERED)
      answerLatestTrustRequest({ trust: true })
      returnedPin = await pending
      pinCallsWhenCallbackResolved = mockSshStore.setHostKeyPin.mock.calls.length
      return {}
    })

    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })

    expect(mockSshStore.setHostKeyPin).toHaveBeenCalledTimes(1)
    expect(mockSshStore.setHostKeyPin).toHaveBeenCalledWith(
      'ssh-1',
      expect.objectContaining({
        source: 'tofu-confirmed',
        fingerprint: OFFERED_FP,
        host: '10.0.0.5',
        port: 22,
        algorithm: 'ssh-ed25519',
        pinnedAt: expect.any(Number)
      })
    )
    expect(pinCallsWhenCallbackResolved).toBe(1)
    expect(returnedPin).toMatchObject({ fingerprint: OFFERED_FP, source: 'tofu-confirmed' })
    // Why: a trust prompt is not a credential prompt, so it must not defer the target at startup.
    expect(mockSshStore.updateTarget).toHaveBeenCalledWith('ssh-1', {
      lastRequiredPassphrase: false
    })
    expect(mockSshStore.updateTarget).not.toHaveBeenCalledWith('ssh-1', {
      lastRequiredPassphrase: true
    })
  })

  it('V-IPC-DECLINE-NO-PIN: declining returns null and persists nothing', async () => {
    const pending = callbacks().onHostKeyTrustRequest!('ssh-1', OFFERED)
    answerLatestTrustRequest({ trust: false })

    await expect(pending).resolves.toBeNull()
    expect(mockSshStore.setHostKeyPin).not.toHaveBeenCalled()
  })

  it('V-IPC-RENDERER-CANNOT-PIN: the answer channel accepts no key material and unknown ids write nothing', async () => {
    const pending = callbacks().onHostKeyTrustRequest!('ssh-1', OFFERED)
    handlers.get('ssh:submitHostKeyTrust')!(null, {
      requestId: 'fabricated',
      trust: true,
      pin: { fingerprint: 'SHA256:FORGED' }
    })
    expect(mockSshStore.setHostKeyPin).not.toHaveBeenCalled()

    answerLatestTrustRequest({ trust: true, pin: { fingerprint: 'SHA256:FORGED' } })
    await pending

    expect(mockSshStore.setHostKeyPin).toHaveBeenCalledTimes(1)
    expect(mockSshStore.setHostKeyPin.mock.calls[0]?.[1]).toMatchObject({ fingerprint: OFFERED_FP })
  })

  it('does not persist when the target vanished before the answer', async () => {
    const pending = callbacks().onHostKeyTrustRequest!('ssh-1', OFFERED)
    mockSshStore.setHostKeyPin.mockReturnValue(null)
    answerLatestTrustRequest({ trust: true })

    await expect(pending).resolves.toBeNull()
  })

  it('V-IPC-AUTOMATIC-NO-PROMPT: runtime and reconnect callers never claim interactivity', async () => {
    mockConnectionManager.connect.mockResolvedValue({})

    await connectRegisteredSshTarget('ssh-1')

    expect(mockConnectionManager.connect).toHaveBeenCalledTimes(1)
    expect(mockConnectionManager.connect.mock.calls[0]).toHaveLength(1)
    expect(trustRequests()).toHaveLength(0)
  })

  it('V-IPC-INTERACTIVE-ONLY-CONNECT-AND-TEST: ssh:connect and ssh:testConnection pass interactive, nothing else does', async () => {
    mockConnectionManager.connect.mockResolvedValue({ getState: () => CONNECTED })
    mockConnectionManager.disconnect.mockResolvedValue(undefined)

    await handlers.get('ssh:testConnection')!(null, { targetId: 'ssh-1' })
    expect(mockConnectionManager.connect).toHaveBeenLastCalledWith(TARGET, { interactive: true })

    mockConnectionManager.connect.mockClear()
    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })
    expect(mockConnectionManager.connect).toHaveBeenLastCalledWith(TARGET, { interactive: true })
  })

  it('V-IPC-PIN-STRIPPED: addTarget and updateTarget drop a renderer-supplied pin', () => {
    const forged = {
      fingerprint: OFFERED_FP,
      host: '10.0.0.5',
      port: 22,
      pinnedAt: 1,
      source: 'manual'
    }
    mockSshStore.addTarget.mockReturnValue(TARGET)

    handlers.get('ssh:addTarget')!(null, {
      target: {
        label: 'Build box',
        host: '10.0.0.5',
        port: 22,
        username: 'deploy',
        hostKeyPin: forged
      }
    })
    handlers.get('ssh:updateTarget')!(null, {
      id: 'ssh-1',
      updates: { label: 'Renamed', hostKeyPin: forged }
    })

    const added = mockSshStore.addTarget.mock.calls[0]?.[0] as Record<string, unknown>
    expect(added).toMatchObject({ label: 'Build box', host: '10.0.0.5' })
    expect('hostKeyPin' in added).toBe(false)
    const [, updates] = mockSshStore.updateTarget.mock.calls[0] as [string, Record<string, unknown>]
    expect(updates).toEqual({ label: 'Renamed' })
  })

  describe('ssh:replaceHostKeyPin', () => {
    const pinnedTarget: SshTarget = {
      ...TARGET,
      hostKeyPin: {
        fingerprint: PINNED_FP,
        host: '10.0.0.5',
        port: 22,
        pinnedAt: 1,
        source: 'tofu-confirmed'
      }
    }

    it('V-IPC-REPLACE-PIN: refuses when the expected fingerprint is not the stored one', () => {
      mockSshStore.getTarget.mockReturnValue(pinnedTarget)

      const result = handlers.get('ssh:replaceHostKeyPin')!(null, {
        targetId: 'ssh-1',
        expectedPreviousFingerprint: OFFERED_FP
      })

      expect(result).toEqual({ replaced: false, reason: 'stale_pin' })
      expect(mockSshStore.setHostKeyPin).not.toHaveBeenCalled()
    })

    it('clears the pin through the flushed setter, logs the act, and the next prompt shows the previous pin', async () => {
      mockSshStore.getTarget.mockReturnValue(pinnedTarget)
      const info = vi.spyOn(console, 'info').mockImplementation(() => {})

      const result = handlers.get('ssh:replaceHostKeyPin')!(null, {
        targetId: 'ssh-1',
        expectedPreviousFingerprint: PINNED_FP
      })

      expect(result).toEqual({ replaced: true })
      expect(mockSshStore.setHostKeyPin).toHaveBeenCalledWith('ssh-1', null)
      expect(info).toHaveBeenCalledWith(expect.stringContaining(PINNED_FP))
      info.mockRestore()

      mockSshStore.getTarget.mockReturnValue(TARGET)
      const pending = callbacks().onHostKeyTrustRequest!('ssh-1', OFFERED)
      expect(trustRequests().at(-1)).toMatchObject({ previousFingerprint: PINNED_FP })
      answerLatestTrustRequest({ trust: false })
      await pending
    })

    it('reports no_pin and target_not_found without touching the store', () => {
      expect(
        handlers.get('ssh:replaceHostKeyPin')!(null, {
          targetId: 'ssh-1',
          expectedPreviousFingerprint: PINNED_FP
        })
      ).toEqual({ replaced: false, reason: 'no_pin' })

      mockSshStore.getTarget.mockReturnValue(undefined)
      expect(
        handlers.get('ssh:replaceHostKeyPin')!(null, {
          targetId: 'ssh-9',
          expectedPreviousFingerprint: PINNED_FP
        })
      ).toEqual({ replaced: false, reason: 'target_not_found' })
      expect(mockSshStore.setHostKeyPin).not.toHaveBeenCalled()
    })
  })

  describe('refusal reaches the renderer', () => {
    it('a changed key broadcasts refused-changed with both fingerprints, and never opens a trust dialog', async () => {
      const refusal = new SshHostKeyRefusedError('host_key_changed', OFFERED, PINNED_FP)
      mockConnectionManager.connect.mockRejectedValue(refusal)

      await expect(handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })).rejects.toBe(refusal)

      const failure = stateBroadcasts().find((state) => state.status === 'error')
      expect(failure).toMatchObject({ hostIdentity: 'refused-changed' })
      expect(failure?.error).toContain(PINNED_FP)
      expect(failure?.error).toContain(OFFERED_FP)
      expect(failure?.error).toContain('Build box')
      expect(failure?.error).toContain('did not change the pin')
      expect(trustRequests()).toHaveLength(0)
      expect(mockSshStore.setHostKeyPin).not.toHaveBeenCalled()
    })

    it('a declined first contact broadcasts refused-unpinned saying the key was not trusted', async () => {
      mockConnectionManager.connect.mockRejectedValue(
        new SshHostKeyRefusedError('host_key_unpinned', OFFERED)
      )

      await expect(handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })).rejects.toThrow()

      const failure = stateBroadcasts().find((state) => state.status === 'error')
      expect(failure).toMatchObject({ hostIdentity: 'refused-unpinned' })
      expect(failure?.error).toBe(`Host key for Build box was not trusted (${OFFERED_FP}).`)
    })

    it('control: an unrelated failure carries no host identity', async () => {
      mockConnectionManager.connect.mockRejectedValue(new Error('connect ETIMEDOUT'))

      await expect(handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })).rejects.toThrow()

      const failure = stateBroadcasts().find((state) => state.status === 'error')
      expect(failure?.error).toBe('connect ETIMEDOUT')
      expect('hostIdentity' in (failure ?? {})).toBe(false)
    })

    it('testConnection reports the owner-facing refusal text', async () => {
      mockConnectionManager.connect.mockRejectedValue(
        new SshHostKeyRefusedError('host_key_changed', OFFERED, PINNED_FP)
      )

      const result = (await handlers.get('ssh:testConnection')!(null, { targetId: 'ssh-1' })) as {
        success: boolean
        error: string
      }

      expect(result.success).toBe(false)
      expect(result.error).toContain('did not change the pin')
    })
  })
})
