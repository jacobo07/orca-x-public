import { describe, expect, it } from 'vitest'
import {
  computeHostKeyFingerprint,
  readHostKeyAlgorithm,
  verifyHostKeyAgainstPin
} from './ssh-host-key-pin-verifier'
import {
  hostKeyObservationToOffered,
  parseSystemSshHostKeyObservation,
  stripOpenSshDebugLines
} from './system-ssh-host-key-observation'

// Captured on GEX44 (OpenSSH_9.6p1 Ubuntu-3ubuntu13.20) against a private loopback sshd with a throwaway
// host key, `ssh -o LogLevel=DEBUG1`. The sshd host key and its `ssh-keygen -lf` fingerprint follow.
const HOST_PUB_BASE64 = 'AAAAC3NzaC1lZDI1NTE5AAAAIE7KcPbNI0VkUXYqf3bS2cePPV9k8x27fSu8pbxC07BU'
const KEYGEN_FINGERPRINT = 'SHA256:D8HvyuasI9QYT2qT2mVqf+WRpSUrzFwwrgYqNUsRldQ'
const REAL_LINE = `debug1: Server host key: ssh-ed25519 ${KEYGEN_FINGERPRINT}\r\n`

// Real stderr excerpt (same run), CRLF as OpenSSH wrote it.
const REAL_STDERR = [
  'debug1: Connection established.',
  'debug1: expecting SSH2_MSG_KEX_ECDH_REPLY',
  'debug1: SSH2_MSG_KEX_ECDH_REPLY received',
  `debug1: Server host key: ssh-ed25519 ${KEYGEN_FINGERPRINT}`,
  'debug1: checking without port identifier',
  'debug1: SSH2_MSG_SERVICE_ACCEPT received',
  'debug1: Authentications that can continue: publickey',
  'Authenticated to 127.0.0.1 ([127.0.0.1]:56183) using "publickey".',
  'debug1: Exit status 0',
  ''
].join('\r\n')

// Real capture from a server whose Banner file carried a forged line: ssh printed it verbatim, after the real one.
const FORGED = 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const REAL_STDERR_WITH_FORGED_BANNER = [
  `debug1: Server host key: ssh-ed25519 ${KEYGEN_FINGERPRINT}\r`,
  'debug1: checking without port identifier\r',
  'debug1: SSH2_MSG_SERVICE_ACCEPT received\r',
  `debug1: Server host key: ssh-ed25519 ${FORGED}`,
  'debug1: SSH2_MSG_EXT_INFO received\r',
  ''
].join('\n')

describe('parseSystemSshHostKeyObservation', () => {
  it('V-SYSKEY-REAL: reads the key OpenSSH verified from a real capture', () => {
    const observation = parseSystemSshHostKeyObservation(REAL_STDERR)

    expect(observation).toEqual({
      kind: 'observed',
      key: { algorithm: 'ssh-ed25519', fingerprint: KEYGEN_FINGERPRINT }
    })
  })

  it('V-SYSKEY-CONTROL: the captured fingerprint is the one OpenSSH and Orca compute for the sshd host key', () => {
    const blob = Buffer.from(HOST_PUB_BASE64, 'base64')
    const observation = parseSystemSshHostKeyObservation(REAL_LINE)

    expect(observation.kind).toBe('observed')
    if (observation.kind !== 'observed') {
      return
    }
    expect(observation.key.fingerprint).toBe(KEYGEN_FINGERPRINT)
    expect(observation.key.fingerprint).toBe(computeHostKeyFingerprint(blob))
    expect(observation.key.algorithm).toBe(readHostKeyAlgorithm(blob))
  })

  it('V-SYSKEY-FORGED: a second line a server smuggled in through its banner makes the capture ambiguous', () => {
    expect(parseSystemSshHostKeyObservation(REAL_STDERR_WITH_FORGED_BANNER)).toEqual({
      kind: 'unobservable',
      reason: 'ambiguous'
    })
  })

  it.each([
    ['empty output', '', 'no-line'],
    ['output without the line', 'debug1: Connection established.\r\nExit status 0\r\n', 'no-line'],
    ['a different case', `debug1: server host key: ssh-ed25519 ${KEYGEN_FINGERPRINT}`, 'no-line'],
    [
      'text before the prefix',
      `Remote: debug1: Server host key: ssh-ed25519 ${KEYGEN_FINGERPRINT}`,
      'no-line'
    ],
    [
      'a truncated fingerprint',
      'debug1: Server host key: ssh-ed25519 SHA256:D8Hvyuasl',
      'malformed'
    ],
    ['a truncated line', 'debug1: Server host key: ssh-ed25519', 'malformed'],
    [
      'a legacy MD5 fingerprint',
      'debug1: Server host key: ssh-rsa MD5:3b:6f:aa:00:11:22:33:44:55:66:77:88:99:aa:bb:cc',
      'malformed'
    ],
    [
      'a SHA1 prefix',
      `debug1: Server host key: ssh-ed25519 SHA1:${KEYGEN_FINGERPRINT.slice(7)}`,
      'malformed'
    ],
    [
      'a lower-case hash name',
      `debug1: Server host key: ssh-ed25519 sha256:${KEYGEN_FINGERPRINT.slice(7)}`,
      'malformed'
    ],
    [
      'trailing text after the fingerprint',
      `debug1: Server host key: ssh-ed25519 ${KEYGEN_FINGERPRINT} extra`,
      'malformed'
    ],
    [
      'a certificate line (its fingerprint covers the certificate, not the key a pin holds)',
      `debug1: Server host key: ssh-ed25519-cert-v01@openssh.com ${KEYGEN_FINGERPRINT}, serial 0 ID "h" CA ssh-ed25519 ${KEYGEN_FINGERPRINT} valid forever`,
      'malformed'
    ],
    [
      'an algorithm with control characters',
      `debug1: Server host key: ssh-\u0001ed ${KEYGEN_FINGERPRINT}`,
      'malformed'
    ]
  ])('V-SYSKEY-MALFORMED: %s is unobservable, never a guessed key', (_name, stderr, reason) => {
    expect(parseSystemSshHostKeyObservation(stderr)).toEqual({ kind: 'unobservable', reason })
  })

  it('V-SYSKEY-NONSTRING: a missing capture is unobservable', () => {
    expect(parseSystemSshHostKeyObservation(undefined as unknown as string)).toEqual({
      kind: 'unobservable',
      reason: 'no-line'
    })
  })
})

describe('hostKeyObservationToOffered', () => {
  it('feeds the pin verifier the same shape the ssh2 path produces', () => {
    const observation = parseSystemSshHostKeyObservation(REAL_STDERR)
    if (observation.kind !== 'observed') {
      throw new Error('fixture must be observable')
    }
    const offered = hostKeyObservationToOffered(observation.key, { host: '127.0.0.1', port: 56183 })
    const pin = {
      fingerprint: KEYGEN_FINGERPRINT,
      host: '127.0.0.1',
      port: 56183,
      pinnedAt: 1,
      source: 'tofu-confirmed' as const
    }

    expect(offered).toEqual({
      fingerprint: KEYGEN_FINGERPRINT,
      algorithm: 'ssh-ed25519',
      host: '127.0.0.1',
      port: 56183
    })
    expect(verifyHostKeyAgainstPin(pin, offered).kind).toBe('pinned-match')
    expect(verifyHostKeyAgainstPin({ ...pin, fingerprint: FORGED }, offered).kind).toBe('changed')
  })
})

describe('stripOpenSshDebugLines', () => {
  it('drops the debug1 lines the observation option adds and keeps the lines a person must read', () => {
    const stderr =
      'debug1: Connection established.\r\nPermission denied (publickey).\r\ndebug1: Exit status 255\r\n'

    expect(stripOpenSshDebugLines(stderr)).toBe('Permission denied (publickey).')
  })

  it('leaves output with no debug lines unchanged apart from trimming', () => {
    expect(stripOpenSshDebugLines('  ssh: connect to host x port 22: Connection refused\n')).toBe(
      'ssh: connect to host x port 22: Connection refused'
    )
  })
})
