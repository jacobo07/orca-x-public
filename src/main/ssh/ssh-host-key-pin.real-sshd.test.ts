import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SshHostKeyPin, SshTarget } from '../../shared/ssh-types'
import type { SshTargetStateOperations } from '../persistence/leasing-ssh-ptys/ssh-target-state'
import {
  addSshTarget,
  getSshTarget,
  setSshTargetHostKeyPin
} from '../persistence/leasing-ssh-ptys/ssh-target-state'
import { SshConnection } from './ssh-connection'
import { SshHostKeyRefusedError } from './ssh-host-key-pin-verifier'

// Why: protected-secret-persistence imports electron at module load; nothing here reaches safeStorage.
vi.mock('electron', () => ({ safeStorage: {}, app: { getPath: () => tmpdir() } }))

/**
 * REAL-SSH plane: drives SshConnection over a real ssh2 handshake against a private sshd (14-06).
 * ORCA_REAL_SSHD_PORT / _USER / _KEY are the sshd and client identity, ORCA_REAL_SSHD_FP_A / _FP_B the
 * OpenSSH-computed fingerprints of the two host keys, ORCA_REAL_SSHD_LEG is A, B or C (one leg per run),
 * ORCA_REAL_SSHD_USERDATA is Leg A's userData dir, read by Leg B. Without a port this file is skipped: NOT RUN.
 * ORCA_SSH_FORCE_SYSTEM_TRANSPORT=1 runs the same legs over the system OpenSSH transport (row 56); a skipped run says NOT RUN.
 */
const PORT = Number(process.env.ORCA_REAL_SSHD_PORT ?? '0')
const USER = process.env.ORCA_REAL_SSHD_USER ?? ''
const KEY = process.env.ORCA_REAL_SSHD_KEY ?? ''
const FP_A = process.env.ORCA_REAL_SSHD_FP_A ?? ''
const FP_B = process.env.ORCA_REAL_SSHD_FP_B ?? ''
const LEG = process.env.ORCA_REAL_SSHD_LEG ?? ''
const LEG_A_USERDATA = process.env.ORCA_REAL_SSHD_USERDATA ?? ''
const STATE_FILE = 'orca-data.json'
const SYSTEM = process.env.ORCA_SSH_FORCE_SYSTEM_TRANSPORT === '1'
const TRANSPORT = SYSTEM ? 'system-openssh' : 'ssh2'

if (!PORT) {
  process.stdout.write(`NOT RUN: real-sshd legs (no ORCA_REAL_SSHD_PORT) transport=${TRANSPORT}\n`)
}

type FileState = { sshTargets: SshTarget[] }

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

// Why: the real setSshTargetHostKeyPin/addSshTarget operate on this state; flush persists it as the app's store does.
function openFileState(userData: string): { ops: SshTargetStateOperations; state: FileState } {
  const file = join(userData, STATE_FILE)
  const state: FileState = existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as FileState)
    : { sshTargets: [] }
  const flush = (): void => writeFileSync(file, JSON.stringify(state))
  const ops = {
    state,
    protectedSecrets: { removeRetainedBlob: () => {} },
    scheduleSave: flush,
    flush
  } as unknown as SshTargetStateOperations
  return { ops, state }
}

function manualTarget(id: string, label: string): SshTarget {
  return {
    id,
    label,
    host: '127.0.0.1',
    port: PORT,
    username: USER,
    identityFile: KEY,
    // Why: without a source, normalization sets configHost=label and the target reads as ssh-config-backed, so ssh -G resolves the label as the host.
    source: 'manual',
    relayGracePeriodSeconds: 1
  }
}

const noopStateChange = (): void => {}

describe.skipIf(!PORT)('SSH host key pin over a real sshd', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  if (LEG === 'A') {
    it('V-REAL-A: first contact pins the key OpenSSH reports, source tofu-confirmed', async () => {
      const userData = mkdtempSync(join(tmpdir(), 'orca-real-sshd-a-'))
      const { ops, state } = openFileState(userData)
      addSshTarget(ops, manualTarget('real-a', 'real-sshd-a'))
      const trustRequests: string[] = []
      const conn = new SshConnection(getSshTarget(state as never, 'real-a')!, {
        onStateChange: noopStateChange,
        onHostKeyTrustRequest: async (targetId, request) => {
          trustRequests.push(request.fingerprint)
          const pin: SshHostKeyPin = {
            fingerprint: request.fingerprint,
            host: request.host,
            port: request.port,
            pinnedAt: Date.now(),
            source: 'tofu-confirmed',
            ...(request.algorithm ? { algorithm: request.algorithm } : {}),
            ...(request.publicKeyBase64 ? { publicKeyBase64: request.publicKeyBase64 } : {})
          }
          return setSshTargetHostKeyPin(ops, targetId, pin)?.hostKeyPin ?? null
        }
      })
      try {
        await conn.connect({ interactive: true })
        expect(conn.getState().status).toBe('connected')
        expect(conn.getState().hostIdentity).toBe('pinned')
        expect(conn.usesSystemSshTransport()).toBe(SYSTEM)
      } finally {
        await conn.disconnect()
      }
      console.log(`PLANE=REAL-SSH/LOCAL-HOST LEG=A TRANSPORT=${TRANSPORT}`)
      const persisted = (JSON.parse(readFileSync(join(userData, STATE_FILE), 'utf8')) as FileState)
        .sshTargets[0].hostKeyPin
      expect(trustRequests).toEqual([FP_A])
      expect(persisted?.source).toBe('tofu-confirmed')
      expect(persisted?.fingerprint).toBe(FP_A)
      console.log(`LEG_A_PIN=${persisted?.fingerprint}`)
      console.log(`LEG_A_USERDATA=${userData}`)
    })
  }

  if (LEG === 'B') {
    it('V-REAL-B: a real key change is refused on interactive and automatic connects, pin untouched', async () => {
      expect(LEG_A_USERDATA).not.toBe('')
      const file = join(LEG_A_USERDATA, STATE_FILE)
      const before = sha256File(file)
      const { state } = openFileState(LEG_A_USERDATA)
      const target = getSshTarget(state as never, 'real-a')!
      expect(target.hostKeyPin?.fingerprint).toBe(FP_A)
      console.log(`LEG_B_USERDATA_SHA_BEFORE=${before}`)

      for (const interactive of [true, false]) {
        const onHostKeyTrustRequest = vi.fn(async () => null)
        const conn = new SshConnection(target, {
          onStateChange: noopStateChange,
          onHostKeyTrustRequest
        })
        const err = await conn.connect({ interactive }).then(
          () => null,
          (caught: unknown) => caught
        )
        expect(err).toBeInstanceOf(SshHostKeyRefusedError)
        const refusal = err as SshHostKeyRefusedError
        expect(refusal.reason).toBe('host_key_changed')
        expect(refusal.pinnedFingerprint).toBe(FP_A)
        expect(refusal.offered.fingerprint).toBe(FP_B)
        expect(refusal.message).toContain(FP_A)
        expect(refusal.message).toContain(FP_B)
        expect(onHostKeyTrustRequest).not.toHaveBeenCalled()
        expect(conn.getState()).toMatchObject({ status: 'error', hostIdentity: 'refused-changed' })
        expect((conn as unknown as { useSystemSshTransport: boolean }).useSystemSshTransport).toBe(
          false
        )
        expect(conn.getTarget().hostKeyPin?.fingerprint).toBe(FP_A)
        console.log(
          `PLANE=REAL-SSH/LOCAL-HOST LEG=B TRANSPORT=${TRANSPORT} LEG_B_REFUSED interactive=${interactive} reason=${refusal.reason}`
        )
      }

      const after = sha256File(file)
      console.log(`LEG_B_USERDATA_SHA_AFTER=${after}`)
      expect(after).toBe(before)
    })
  }

  if (LEG === 'C') {
    it('V-REAL-C: an unpinned automatic connect is refused host_key_unpinned and no pin is written', async () => {
      const userData = mkdtempSync(join(tmpdir(), 'orca-real-sshd-c-'))
      const { ops, state } = openFileState(userData)
      addSshTarget(ops, manualTarget('real-c', 'real-sshd-c'))
      const onHostKeyTrustRequest = vi.fn(async () => null)
      const conn = new SshConnection(getSshTarget(state as never, 'real-c')!, {
        onStateChange: noopStateChange,
        onHostKeyTrustRequest
      })
      const err = await conn.connect().then(
        () => null,
        (caught: unknown) => caught
      )
      expect(err).toBeInstanceOf(SshHostKeyRefusedError)
      expect((err as SshHostKeyRefusedError).reason).toBe('host_key_unpinned')
      expect((err as SshHostKeyRefusedError).offered.fingerprint).toBe(FP_A)
      expect(conn.getState()).toMatchObject({ status: 'error', hostIdentity: 'refused-unpinned' })
      // Why: an automatic connect has no consent surface, so the owner is never asked.
      expect(onHostKeyTrustRequest).not.toHaveBeenCalled()
      const persisted = JSON.parse(readFileSync(join(userData, STATE_FILE), 'utf8')) as FileState
      expect(persisted.sshTargets[0].hostKeyPin).toBeUndefined()
      expect(conn.getTarget().hostKeyPin).toBeUndefined()
      console.log(
        `PLANE=REAL-SSH/LOCAL-HOST LEG=C TRANSPORT=${TRANSPORT} LEG_C_REFUSED reason=${(err as SshHostKeyRefusedError).reason}`
      )
    })
  }
})
