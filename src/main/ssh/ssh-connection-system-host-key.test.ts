import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  findSystemSshMock,
  resetSshConnectionMocks,
  resolveWithSshGMock
} from './ssh-connection-test-harness'
import { createCallbacks, createResolvedConfig, createTarget } from './ssh-connection-test-fixtures'
import { SshConnection } from './ssh-connection'
import { isSshHostKeyRefusedError } from './ssh-host-key-pin-verifier'
import type { SshConnectionCallbacks } from './ssh-connection'
import type { SshHostKeyPin, SshTarget } from '../../shared/ssh-types'

vi.mock('ssh2', async () => (await import('./ssh-connection-test-harness')).createSsh2Module())
vi.mock('./system-ssh-binary', async () =>
  (await import('./ssh-connection-test-harness')).createSystemSshBinaryModule()
)
vi.mock('./ssh-config-parser', async () =>
  (await import('./ssh-connection-test-harness')).createSshConfigParserModule()
)

// Real `ssh -o LogLevel=DEBUG1` capture from GEX44 (OpenSSH_9.6p1), see system-ssh-host-key-observation.test.ts.
const KEY_A = 'SHA256:D8HvyuasI9QYT2qT2mVqf+WRpSUrzFwwrgYqNUsRldQ'
const KEY_B = `SHA256:${'B'.repeat(43)}`
const LINE_A = `debug1: Server host key: ssh-ed25519 ${KEY_A}\r\n`
const LINE_B = `debug1: Server host key: ssh-ed25519 ${KEY_B}\r\n`

// Stands in for the system ssh: like the real one it prints the host key line only for a handshake that was asked
// to log, creates the ControlPath socket when it becomes a master, and prints nothing when a master already exists.
const FAKE_SSH = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_SSH_DIR/calls.log"
cp=""
log=0
op=0
for a in "$@"; do
  case "$a" in
    ControlPath=*) cp="\${a#ControlPath=}" ;;
    LogLevel=DEBUG1) log=1 ;;
    -O) op=1 ;;
  esac
done
if [ "$op" = 1 ]; then
  echo "Exit request sent." >&2
  [ -n "$cp" ] && rm -f "$cp"
  exit 0
fi
if [ -n "$cp" ] && [ -e "$cp" ]; then
  echo ORCA-SYSTEM-SSH-OK
  exit 0
fi
[ -n "$cp" ] && : > "$cp"
[ "$log" = 1 ] && cat "$FAKE_SSH_DIR/stderr.txt" >&2
echo ORCA-SYSTEM-SSH-OK
exit 0
`

function pinFor(fingerprint: string, overrides?: Partial<SshHostKeyPin>): SshHostKeyPin {
  return {
    fingerprint,
    host: 'example.com',
    port: 22,
    pinnedAt: 1,
    source: 'tofu-confirmed',
    ...overrides
  }
}

describe.skipIf(process.platform === 'win32')('SshConnection system transport host key', () => {
  let dir: string

  function serverPrints(stderr: string): void {
    writeFileSync(join(dir, 'stderr.txt'), stderr)
  }

  function sshCalls(): string[] {
    const path = join(dir, 'calls.log')
    return existsSync(path) ? readFileSync(path, 'utf-8').split('\n').filter(Boolean) : []
  }

  function connectionFor(
    overrides?: Partial<SshTarget>,
    callbacks?: Partial<SshConnectionCallbacks>
  ): SshConnection {
    // Why: configHost routes the target through the system transport once the resolver reports fdpass.
    resolveWithSshGMock.mockResolvedValue(createResolvedConfig())
    return new SshConnection(
      createTarget({ configHost: 'fdpass-host', ...overrides }),
      createCallbacks(callbacks)
    )
  }

  beforeEach(() => {
    resetSshConnectionMocks()
    dir = mkdtempSync(join(tmpdir(), 'orca-sys-hostkey-'))
    const fake = join(dir, 'ssh')
    writeFileSync(fake, FAKE_SSH)
    chmodSync(fake, 0o755)
    findSystemSshMock.mockReturnValue(fake)
    vi.stubEnv('FAKE_SSH_DIR', dir)
    // Why: the real control-socket path code puts the socket under XDG_RUNTIME_DIR; keep it inside the temp dir.
    vi.stubEnv('XDG_RUNTIME_DIR', dir)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
  })

  it('V-SYSHK-PINNED: an observed key equal to the pin connects and reads pinned, not delegated', async () => {
    serverPrints(LINE_A)
    const conn = connectionFor({ hostKeyPin: pinFor(KEY_A) })

    await conn.connect()

    expect(conn.usesSystemSshTransport()).toBe(true)
    expect(conn.getState().status).toBe('connected')
    expect(conn.getState().hostIdentity).toBe('pinned')
    expect(sshCalls()[0]).toContain('LogLevel=DEBUG1')
  })

  it('V-SYSHK-CHANGED: a different key is refused host_key_changed and the master is retired', async () => {
    serverPrints(LINE_B)
    const conn = connectionFor({ hostKeyPin: pinFor(KEY_A) })

    const error = await conn.connect().catch((err: unknown) => err)

    expect(isSshHostKeyRefusedError(error)).toBe(true)
    expect(error).toMatchObject({ reason: 'host_key_changed', pinnedFingerprint: KEY_A })
    expect(conn.getState().hostIdentity).toBe('refused-changed')
    expect(conn.getState().status).toBe('error')
    expect(conn.usesSystemSshTransport()).toBe(false)
    // The only later call is the exit request; nothing ran over the unverified session.
    const calls = sshCalls()
    expect(calls).toHaveLength(2)
    expect(calls[1]).toMatch(/^-O exit /)
  })

  it('V-SYSHK-UNPINNED-AUTO: an unpinned target is refused exactly as the ssh2 path refuses it', async () => {
    serverPrints(LINE_A)
    const conn = connectionFor()

    const error = await conn.connect().catch((err: unknown) => err)

    expect(error).toMatchObject({ reason: 'host_key_unpinned' })
    expect(conn.getState().hostIdentity).toBe('refused-unpinned')
  })

  it('V-SYSHK-ENDPOINT: a pin recorded for another endpoint is not applied', async () => {
    serverPrints(LINE_A)
    const conn = connectionFor({ hostKeyPin: pinFor(KEY_A, { host: 'other.example' }) })

    const error = await conn.connect().catch((err: unknown) => err)

    expect(error).toMatchObject({ reason: 'host_key_unpinned' })
  })

  it('V-SYSHK-UNPINNED-INTERACTIVE: the owner confirming the offered key pins it and the session connects', async () => {
    serverPrints(LINE_A)
    const onHostKeyTrustRequest = vi.fn(async (_id: string, offered: { fingerprint: string }) =>
      pinFor(offered.fingerprint)
    )
    const conn = connectionFor(undefined, { onHostKeyTrustRequest })

    await conn.connect({ interactive: true })

    expect(onHostKeyTrustRequest).toHaveBeenCalledWith(
      'target-1',
      expect.objectContaining({ host: 'example.com', port: 22, fingerprint: KEY_A })
    )
    expect(conn.getState().hostIdentity).toBe('pinned')
    expect(conn.getState().status).toBe('connected')
  })

  it('V-SYSHK-UNPINNED-DECLINED: the owner declining refuses and retires the master', async () => {
    serverPrints(LINE_A)
    const conn = connectionFor(undefined, { onHostKeyTrustRequest: vi.fn(async () => null) })

    const error = await conn.connect({ interactive: true }).catch((err: unknown) => err)

    expect(error).toMatchObject({ reason: 'host_key_unpinned' })
    expect(sshCalls().at(-1)).toMatch(/^-O exit /)
  })

  it('V-SYSHK-UNPINNED-WRONG-PIN: a confirmation naming another key than the one observed is refused', async () => {
    serverPrints(LINE_A)
    const conn = connectionFor(undefined, {
      onHostKeyTrustRequest: vi.fn(async () => pinFor(KEY_B))
    })

    const error = await conn.connect({ interactive: true }).catch((err: unknown) => err)

    expect(error).toMatchObject({ reason: 'host_key_unpinned' })
  })

  it('V-SYSHK-UNOBSERVABLE-AUTO: no observation on an automatic connect is host_key_unverifiable', async () => {
    serverPrints('debug1: Connection established.\r\n')
    const conn = connectionFor({ hostKeyPin: pinFor(KEY_A) })

    const error = await conn.connect().catch((err: unknown) => err)

    expect(error).toMatchObject({ reason: 'host_key_unverifiable' })
    expect(conn.getState().hostIdentity).toBe('unverifiable')
    expect(conn.getState().hostIdentity).not.toBe('pinned')
  })

  it('V-SYSHK-UNOBSERVABLE-INTERACTIVE: the same capture on an interactive connect keeps delegated-to-openssh', async () => {
    serverPrints('debug1: Connection established.\r\n')
    const conn = connectionFor({ hostKeyPin: pinFor(KEY_A) })

    await conn.connect({ interactive: true })

    expect(conn.getState().status).toBe('connected')
    expect(conn.getState().hostIdentity).toBe('delegated-to-openssh')
  })

  it('V-SYSHK-FORGED-BANNER: a second line from a server banner is not trusted on an automatic connect', async () => {
    serverPrints(`${LINE_B}${LINE_A}`)
    const conn = connectionFor({ hostKeyPin: pinFor(KEY_A) })

    const error = await conn.connect().catch((err: unknown) => err)

    expect(error).toMatchObject({ reason: 'host_key_unverifiable' })
  })

  it('V-SYSHK-STALE-MASTER: a master left from an earlier session is retired so this handshake is observed', async () => {
    serverPrints(LINE_B)
    const conn = connectionFor({ hostKeyPin: pinFor(KEY_B) })
    // First connect leaves the fake master socket behind, as ControlPersist does.
    await conn.connect()
    serverPrints(LINE_A)
    const again = connectionFor({ hostKeyPin: pinFor(KEY_B) })

    const error = await again.connect().catch((err: unknown) => err)

    expect(error).toMatchObject({ reason: 'host_key_changed' })
    expect(sshCalls().some((call) => call.startsWith('-O exit '))).toBe(true)
  })

  it('V-SYSHK-UNBOUND: without connection reuse nothing is observed and automatic connects are refused', async () => {
    serverPrints(LINE_A)
    const conn = connectionFor({ hostKeyPin: pinFor(KEY_A), systemSshConnectionReuse: false })

    const error = await conn.connect().catch((err: unknown) => err)

    expect(error).toMatchObject({ reason: 'host_key_unverifiable' })
    expect(sshCalls().every((call) => !call.includes('LogLevel=DEBUG1'))).toBe(true)
  })

  it('V-SYSHK-UNBOUND-INTERACTIVE: without connection reuse an interactive connect stays delegated', async () => {
    serverPrints(LINE_A)
    const conn = connectionFor({ hostKeyPin: pinFor(KEY_A), systemSshConnectionReuse: false })

    await conn.connect({ interactive: true })

    expect(conn.getState().hostIdentity).toBe('delegated-to-openssh')
  })
})
