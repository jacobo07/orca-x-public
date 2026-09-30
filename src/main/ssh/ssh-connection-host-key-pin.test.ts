import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { utils } from 'ssh2'
import {
  clientInstances,
  connectAttempts,
  resetSshConnectionMocks,
  spawnSystemSshCommandMock,
  spawnSystemSshMock,
  ssh2Mock
} from './ssh-connection-test-harness'
import { createCallbacks, createResolvedConfig, createTarget } from './ssh-connection-test-fixtures'
import { SshConnection } from './ssh-connection'
import { resolveWithSshG } from './ssh-config-parser'
import {
  SshHostKeyRefusedError,
  computeHostKeyFingerprint,
  getUnpinnedAutomaticConnectCount,
  resetUnpinnedAutomaticConnectCounts
} from './ssh-host-key-pin-verifier'
import type { SshHostKeyPin } from '../../shared/ssh-types'

vi.mock('ssh2', async () => (await import('./ssh-connection-test-harness')).createSsh2Module())
vi.mock('./system-ssh-binary', async () =>
  (await import('./ssh-connection-test-harness')).createSystemSshBinaryModule()
)
vi.mock('./ssh-system-fallback', async () =>
  (await import('./ssh-connection-test-harness')).createSystemFallbackModule()
)
vi.mock('./ssh-control-socket', async () =>
  (await import('./ssh-connection-test-harness')).createControlSocketModule()
)
vi.mock('./ssh-config-parser', async () =>
  (await import('./ssh-connection-test-harness')).createSshConfigParserModule()
)

const GOOD_KEY = Buffer.from('mock-ssh-host-key')
const OTHER_KEY = Buffer.from('a-different-host-key')

function pinFor(key: Buffer, overrides?: Partial<SshHostKeyPin>): SshHostKeyPin {
  return {
    fingerprint: computeHostKeyFingerprint(key),
    host: 'example.com',
    port: 22,
    pinnedAt: 1,
    source: 'tofu-confirmed',
    ...overrides
  }
}

async function captureRefusal(promise: Promise<unknown>): Promise<SshHostKeyRefusedError> {
  const err = await promise.then(
    () => null,
    (caught: unknown) => caught
  )
  expect(err).toBeInstanceOf(SshHostKeyRefusedError)
  return err as SshHostKeyRefusedError
}

describe('SshConnection host key pinning', () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    resetSshConnectionMocks()
    resetUnpinnedAutomaticConnectCounts()
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
  })

  it('V-SSH-MATCH-CONNECTS: a matching pin connects on an automatic attempt and reports pinned', async () => {
    const conn = new SshConnection(
      createTarget({ hostKeyPin: pinFor(GOOD_KEY) }),
      createCallbacks()
    )

    await conn.connect()

    expect(conn.getState().status).toBe('connected')
    expect(conn.getState().hostIdentity).toBe('pinned')
    expect(getUnpinnedAutomaticConnectCount('target-1')).toBe(0)
  })

  it.each([false, true])(
    'V-SSH-CHANGED-REFUSED: a changed key is refused, interactive=%s, with no prompt and no pin change',
    async (interactive) => {
      ssh2Mock.hostKey = OTHER_KEY
      const pin = pinFor(GOOD_KEY)
      const onHostKeyTrustRequest = vi.fn(async () => pinFor(OTHER_KEY))
      const callbacks = createCallbacks({ onHostKeyTrustRequest })
      const conn = new SshConnection(createTarget({ hostKeyPin: pin }), callbacks)

      const refusal = await captureRefusal(conn.connect({ interactive }))

      expect(refusal.reason).toBe('host_key_changed')
      expect(refusal.pinnedFingerprint).toBe(pin.fingerprint)
      expect(refusal.offered.fingerprint).toBe(computeHostKeyFingerprint(OTHER_KEY))
      expect(conn.getState()).toMatchObject({ status: 'error', hostIdentity: 'refused-changed' })
      expect(conn.getTarget().hostKeyPin).toEqual(pin)
      expect(onHostKeyTrustRequest).not.toHaveBeenCalled()
      expect(connectAttempts).toBe(1)
    }
  )

  it('V-SSH-NO-FALLBACK: a refusal is never routed to system ssh, whatever its message contains', async () => {
    ssh2Mock.hostKey = OTHER_KEY
    // Why: the message embeds the host, so a hostile name must not flip any error classifier.
    for (const host of ['EHOSTUNREACH.test', 'ETIMEDOUT.test']) {
      const target = createTarget({ host, hostKeyPin: pinFor(GOOD_KEY, { host }) })
      const conn = new SshConnection(target, createCallbacks())
      const refusal = await captureRefusal(conn.connect())
      expect(refusal.message).toContain(host)
    }
    expect(spawnSystemSshCommandMock).not.toHaveBeenCalled()
    expect(spawnSystemSshMock).not.toHaveBeenCalled()
    expect(connectAttempts).toBe(2)
  })

  it('V-SSH-NO-FALLBACK: a refusal never reaches the credential prompts', async () => {
    vi.stubEnv('SSH_AUTH_SOCK', '')
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-ssh-pin-key-'))
    const keyPath = join(tempDir, 'id_ed25519')
    writeFileSync(keyPath, 'test-key')
    vi.mocked(utils.parseKey).mockReturnValue(
      new Error('Encrypted private OpenSSH key detected, but no passphrase given') as never
    )
    try {
      // Positive control: this fixture does reach the passphrase prompt when the host key is fine.
      const controlPrompt = vi.fn(async () => 'passphrase-1')
      ssh2Mock.connectSequence = [
        new Error('Encrypted private OpenSSH key detected, but no passphrase given'),
        'ready'
      ]
      const control = new SshConnection(
        createTarget({ identityFile: keyPath, hostKeyPin: pinFor(GOOD_KEY) }),
        createCallbacks({ onCredentialRequest: controlPrompt })
      )
      await control.connect()
      expect(controlPrompt).toHaveBeenCalledTimes(1)
      // Why: the mock fans an error out to every live client, which would schedule a stray reconnect.
      await control.disconnect()

      ssh2Mock.hostKey = OTHER_KEY
      const onCredentialRequest = vi.fn(async () => 'passphrase-2')
      const conn = new SshConnection(
        createTarget({ identityFile: keyPath, hostKeyPin: pinFor(GOOD_KEY) }),
        createCallbacks({ onCredentialRequest })
      )
      const refusal = await captureRefusal(conn.connect({ interactive: true }))

      expect(refusal.reason).toBe('host_key_changed')
      expect(onCredentialRequest).not.toHaveBeenCalled()
    } finally {
      vi.mocked(utils.parseKey).mockReset()
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('V-SSH-NO-FALLBACK: a refused reconnect is terminal and schedules no retry', async () => {
    const conn = new SshConnection(
      createTarget({ hostKeyPin: pinFor(GOOD_KEY) }),
      createCallbacks()
    )
    await conn.connect()
    ssh2Mock.hostKey = OTHER_KEY
    const private_ = conn as unknown as { reconnectTimer: unknown }

    await conn.reconnect()

    expect(conn.getState()).toMatchObject({ status: 'error', hostIdentity: 'refused-changed' })
    expect(private_.reconnectTimer).toBeNull()
    expect(clientInstances).toHaveLength(2)
    await conn.disconnect()
  })

  it('V-SSH-NO-FALLBACK: a key that changes during the agent-to-key retry is refused, not prompted', async () => {
    vi.stubEnv('SSH_AUTH_SOCK', '/tmp/agent.sock')
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-ssh-pin-retry-'))
    const keyPath = join(tempDir, 'id_ed25519')
    writeFileSync(keyPath, 'test-key')
    vi.mocked(utils.parseKey).mockReturnValue(
      new Error('Encrypted private OpenSSH key detected, but no passphrase given') as never
    )
    const authFailure = new Error('All configured authentication methods failed')
    const passphraseFailure = new Error('Encrypted private OpenSSH key detected, but no passphrase')
    try {
      // Positive control: with a stable key this route reaches the passphrase prompt.
      ssh2Mock.connectSequence = [authFailure, passphraseFailure, 'ready']
      const controlPrompt = vi.fn(async () => 'passphrase-1')
      const control = new SshConnection(
        createTarget({ identityFile: keyPath, hostKeyPin: pinFor(GOOD_KEY) }),
        createCallbacks({ onCredentialRequest: controlPrompt })
      )
      await control.connect()
      expect(controlPrompt).toHaveBeenCalledTimes(1)
      await control.disconnect()

      ssh2Mock.connectSequence = [authFailure]
      ssh2Mock.hostKeySequence = [GOOD_KEY, OTHER_KEY]
      const onCredentialRequest = vi.fn(async () => 'passphrase-2')
      const conn = new SshConnection(
        createTarget({ identityFile: keyPath, hostKeyPin: pinFor(GOOD_KEY) }),
        createCallbacks({ onCredentialRequest })
      )

      const refusal = await captureRefusal(conn.connect({ interactive: true }))

      expect(refusal.reason).toBe('host_key_changed')
      expect(onCredentialRequest).not.toHaveBeenCalled()
    } finally {
      vi.mocked(utils.parseKey).mockReset()
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('V-SSH-TOFU-CONFIRM: an interactive first contact asks once, adopts the confirmed pin and retries once', async () => {
    const onHostKeyTrustRequest = vi.fn(async () => pinFor(GOOD_KEY))
    const conn = new SshConnection(createTarget(), createCallbacks({ onHostKeyTrustRequest }))

    await conn.connect({ interactive: true })

    expect(onHostKeyTrustRequest).toHaveBeenCalledTimes(1)
    expect(onHostKeyTrustRequest).toHaveBeenCalledWith('target-1', {
      host: 'example.com',
      port: 22,
      fingerprint: computeHostKeyFingerprint(GOOD_KEY),
      publicKeyBase64: GOOD_KEY.toString('base64')
    })
    expect(connectAttempts).toBe(2)
    expect(conn.getState()).toMatchObject({ status: 'connected', hostIdentity: 'pinned' })
    expect(conn.getTarget().hostKeyPin).toEqual(pinFor(GOOD_KEY))
  })

  it('an interactive answer naming a different key is not adopted', async () => {
    const onHostKeyTrustRequest = vi.fn(async () => pinFor(OTHER_KEY))
    const conn = new SshConnection(createTarget(), createCallbacks({ onHostKeyTrustRequest }))

    const refusal = await captureRefusal(conn.connect({ interactive: true }))

    expect(refusal.reason).toBe('host_key_unpinned')
    expect(conn.getTarget().hostKeyPin).toBeUndefined()
    expect(connectAttempts).toBe(1)
  })

  it('V-SSH-TOFU-DENY: null (decline or timeout) refuses first contact and records nothing', async () => {
    const onHostKeyTrustRequest = vi.fn(async () => null)
    const conn = new SshConnection(createTarget(), createCallbacks({ onHostKeyTrustRequest }))

    const refusal = await captureRefusal(conn.connect({ interactive: true }))

    expect(refusal.reason).toBe('host_key_unpinned')
    expect(conn.getState()).toMatchObject({ status: 'error', hostIdentity: 'refused-unpinned' })
    expect(conn.getTarget().hostKeyPin).toBeUndefined()
    expect(connectAttempts).toBe(1)
  })

  it('an interactive attempt with nobody to ask refuses first contact', async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())

    const refusal = await captureRefusal(conn.connect({ interactive: true }))

    expect(refusal.reason).toBe('host_key_unpinned')
  })

  it('V-SSH-NO-SILENT-TOFU: an automatic first contact connects loudly, counted, and never pins', async () => {
    const onHostKeyTrustRequest = vi.fn(async () => pinFor(GOOD_KEY))
    const conn = new SshConnection(createTarget(), createCallbacks({ onHostKeyTrustRequest }))

    await conn.connect()

    expect(conn.getState()).toMatchObject({ status: 'connected', hostIdentity: 'unpinned-legacy' })
    expect(onHostKeyTrustRequest).not.toHaveBeenCalled()
    expect(conn.getTarget().hostKeyPin).toBeUndefined()
    expect(getUnpinnedAutomaticConnectCount('target-1')).toBe(1)
    const warnings = warn.mock.calls.filter(([line]) =>
      String(line).includes('[ssh-host-key] unpinned')
    )
    expect(warnings).toHaveLength(1)
  })

  it('V-SSH-PIN-RESET-AUTOMATIC-REFUSED: a target whose pin was removed refuses an automatic connect', async () => {
    const onHostKeyTrustRequest = vi.fn(async () => pinFor(GOOD_KEY))
    const conn = new SshConnection(
      createTarget({ hostKeyPinReset: true }),
      createCallbacks({ onHostKeyTrustRequest })
    )

    const refusal = await captureRefusal(conn.connect())

    expect(refusal.reason).toBe('host_key_unpinned')
    expect(conn.getState()).toMatchObject({ status: 'error', hostIdentity: 'refused-unpinned' })
    expect(onHostKeyTrustRequest).not.toHaveBeenCalled()
    expect(getUnpinnedAutomaticConnectCount('target-1')).toBe(0)
  })

  it('V-SSH-PIN-RESET-INTERACTIVE-PROMPTS: an interactive connect still asks, and the confirmed pin clears the marker', async () => {
    const onHostKeyTrustRequest = vi.fn(async () => pinFor(GOOD_KEY))
    const conn = new SshConnection(
      createTarget({ hostKeyPinReset: true }),
      createCallbacks({ onHostKeyTrustRequest })
    )

    await conn.connect({ interactive: true })

    expect(onHostKeyTrustRequest).toHaveBeenCalledTimes(1)
    expect(conn.getState()).toMatchObject({ status: 'connected', hostIdentity: 'pinned' })
    expect(conn.getTarget().hostKeyPinReset).toBeUndefined()
  })

  it('a pin for a different host or port reads unpinned, not changed', async () => {
    const conn = new SshConnection(
      createTarget({ hostKeyPin: pinFor(OTHER_KEY, { port: 2222 }) }),
      createCallbacks()
    )

    await conn.connect()

    expect(conn.getState().hostIdentity).toBe('unpinned-legacy')
  })

  it('V-SSH-PIN-ENDPOINT-MISMATCH: CHARACTERIZATION - a pin for another endpoint still gets the legacy automatic grace', async () => {
    const onHostKeyTrustRequest = vi.fn(async () => pinFor(OTHER_KEY))
    const conn = new SshConnection(
      createTarget({ hostKeyPin: pinFor(OTHER_KEY, { host: 'elsewhere.example' }) }),
      createCallbacks({ onHostKeyTrustRequest })
    )

    await conn.connect()

    expect(conn.getState()).toMatchObject({ status: 'connected', hostIdentity: 'unpinned-legacy' })
    expect(getUnpinnedAutomaticConnectCount('target-1')).toBe(1)
    expect(onHostKeyTrustRequest).not.toHaveBeenCalled()
  })
  it.each([false, true])(
    'V-SSH-MALFORMED-REFUSED: a damaged pin refuses interactive=%s attempts',
    async (interactive) => {
      const damaged = { fingerprint: 'nope' } as unknown as SshHostKeyPin
      const onHostKeyTrustRequest = vi.fn(async () => pinFor(GOOD_KEY))
      const conn = new SshConnection(
        createTarget({ hostKeyPin: damaged }),
        createCallbacks({ onHostKeyTrustRequest })
      )

      const refusal = await captureRefusal(conn.connect({ interactive }))

      expect(refusal.reason).toBe('host_key_unverifiable')
      expect(conn.getState().hostIdentity).toBe('unverifiable')
      expect(onHostKeyTrustRequest).not.toHaveBeenCalled()
      expect(conn.getTarget().hostKeyPin).toEqual(damaged)
    }
  )

  it('V-SSH-DELEGATED: the system OpenSSH transport reports delegated, never pinned', async () => {
    vi.mocked(resolveWithSshG).mockResolvedValueOnce(createResolvedConfig())
    const conn = new SshConnection(
      createTarget({ configHost: 'fdpass-host', hostKeyPin: pinFor(GOOD_KEY) }),
      createCallbacks()
    )

    await conn.connect()

    expect(conn.usesSystemSshTransport()).toBe(true)
    expect(clientInstances).toHaveLength(0)
    expect(conn.getState()).toMatchObject({
      status: 'connected',
      hostIdentity: 'delegated-to-openssh'
    })
    expect(conn.getHostKeyFingerprint()).toBeUndefined()
  })
})
