import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDaemonPidPath, serializeDaemonPidFile } from './daemon-spawner'
import type { SocketProbeOutcome } from './daemon-endpoint-probe'

vi.mock('./daemon-pid-identity', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  inspectDaemonProcessIdentity: vi.fn(async () => 'match')
}))

const { killStaleDaemon } = await import('./daemon-stale-kill')

const RECORDED_PID = 2_000_001

// R-09: after the recorded daemon's exit is confirmed, a bare connect names a listener, not the
// identity of the daemon we watched die. Only a protocol answer proves a live owner.
describe('killStaleDaemon tail after a confirmed exit', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let killSpy: ReturnType<typeof vi.spyOn>
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-tail-test-'))
    socketPath = join(dir, 'daemon.sock')
    tokenPath = join(dir, 'daemon.token')
    writeFileSync(
      getDaemonPidPath(dir),
      serializeDaemonPidFile({ pid: RECORDED_PID, startedAtMs: null, launchNonce: 'recorded' }),
      { mode: 0o600 }
    )
    // SIGTERM is accepted, then the liveness signal reports the pid gone: exit confirmed.
    killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 0) {
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
      }
      return true
    })
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    killSpy.mockRestore()
    warn.mockRestore()
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  function run(
    outcome: SocketProbeOutcome,
    probeEndpointOwner: () => Promise<number | null>
  ): ReturnType<typeof killStaleDaemon> {
    return killStaleDaemon(dir, socketPath, tokenPath, undefined, {
      probeEndpoint: async () => outcome,
      probeEndpointOwner
    })
  }

  it('answering: a protocol answer is a live owner (endpoint_still_serving)', async () => {
    const owner = vi.fn(async () => 2)

    await expect(run('connected', owner)).resolves.toEqual({
      killed: true,
      liveOwnerSurvived: true,
      preservedBy: 'endpoint_still_serving'
    })
    expect(owner).toHaveBeenCalledWith(socketPath)
  })

  it.each<SocketProbeOutcome>(['refused', 'missing'])(
    '%s: nothing accepts, the endpoint is dead and the owner probe is not asked',
    async (outcome) => {
      const owner = vi.fn(async () => 1)

      await expect(run(outcome, owner)).resolves.toEqual({ killed: true, liveOwnerSurvived: false })
      expect(owner).not.toHaveBeenCalled()
    }
  )

  it('connected-without-answer: a null answer is unknown, kept fail-closed (endpoint_unverified)', async () => {
    await expect(run('connected', async () => null)).resolves.toEqual({
      killed: true,
      liveOwnerSurvived: true,
      preservedBy: 'endpoint_unverified'
    })
    expect(warn.mock.calls.map((call) => String(call[0]))).toEqual(
      expect.arrayContaining([expect.stringContaining('reason=endpoint_unverified')])
    )
  })

  it('connected-without-answer: a rejecting owner probe is unknown, kept fail-closed', async () => {
    const owner = vi.fn(async (): Promise<number | null> => {
      throw new Error('protocol error')
    })

    await expect(run('connected', owner)).resolves.toEqual({
      killed: true,
      liveOwnerSurvived: true,
      preservedBy: 'endpoint_unverified'
    })
  })

  it('hung-connect: an owner probe that never settles ends unknown at the bound, never a hang or absent', async () => {
    vi.useFakeTimers()
    const owner = vi.fn(() => new Promise<number | null>(() => {}))

    const outcome = run('connected', owner)
    await vi.advanceTimersByTimeAsync(60_000)

    await expect(outcome).resolves.toEqual({
      killed: true,
      liveOwnerSurvived: true,
      preservedBy: 'endpoint_unverified'
    })
    expect(owner).toHaveBeenCalledOnce()
  })

  it('the pid record of the exited daemon is unlinked once its exit is confirmed, whatever the endpoint says', async () => {
    await run('connected', async () => null)

    expect(() => readFileSync(getDaemonPidPath(dir), 'utf8')).toThrow()
  })

  it('unchanged: nothing killed and a connected endpoint is still an unidentified listener we never asked', async () => {
    rmSync(getDaemonPidPath(dir))
    const owner = vi.fn(async () => null)

    await expect(run('connected', owner)).resolves.toEqual({
      killed: false,
      liveOwnerSurvived: true,
      preservedBy: 'endpoint_still_serving'
    })
    expect(owner).not.toHaveBeenCalled()
  })
})
