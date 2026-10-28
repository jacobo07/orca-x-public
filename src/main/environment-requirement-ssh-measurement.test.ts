import { describe, expect, it } from 'vitest'
import { measureRequirementsOverSsh } from './environment-requirement-ssh-measurement'
import type {
  EnvironmentRequirement,
  HostMeasurement
} from '../shared/environment-requirement-types'

type Call = { method: string; params: unknown; timeoutMs: number | undefined }

function codedError(code: string | number, message = 'x'): Error {
  return Object.assign(new Error(message), { code })
}

const CAPABILITY = 'environment.requirements.v1'

const git: EnvironmentRequirement = {
  id: 'git',
  kind: 'command',
  name: 'git',
  versionArg: '--version',
  versionRange: {
    status: 'supported',
    raw: '>=2',
    comparators: [{ op: '>=', version: [2, 0, 0] }]
  }
}

function setup(options: {
  mux?: 'none' | 'disposed' | 'live'
  status?: unknown | Error
  method?: unknown | Error
}): {
  calls: Call[]
  measure: (requirements?: EnvironmentRequirement[]) => Promise<HostMeasurement>
} {
  const calls: Call[] = []
  const live = {
    isDisposed: () => options.mux === 'disposed',
    request: async (method: string, params?: unknown, requestOptions?: { timeoutMs?: number }) => {
      calls.push({ method, params, timeoutMs: requestOptions?.timeoutMs })
      const outcome = method === 'relay.status' ? options.status : options.method
      if (outcome instanceof Error) {
        throw outcome
      }
      return outcome
    }
  }
  return {
    calls,
    measure: (requirements = [git]) =>
      measureRequirementsOverSsh({
        connectionId: 'c1',
        hostKey: 'ssh:t@abc',
        workspacePath: '/home/u/project',
        requirements,
        deps: {
          getMultiplexer: async () => (options.mux === 'none' ? undefined : live),
          now: () => 1_700_000_000_000
        }
      })
  }
}

const okStatus = { capabilities: ['skills.install.v1', CAPABILITY], pid: 1 }
const okMethod = {
  platform: { os: 'linux', arch: 'x64' },
  probes: [{ id: 'git', outcome: 'found', resolvedPath: '/usr/bin/git', version: '2.43.0' }]
}

function status(result: HostMeasurement): string {
  return result.status
}

describe('measureRequirementsOverSsh', () => {
  it('measures through the relay and returns its probes', async () => {
    const { measure, calls } = setup({ mux: 'live', status: okStatus, method: okMethod })
    const result = await measure()
    expect(result).toEqual({
      status: 'measured',
      at: 1_700_000_000_000,
      hostKey: 'ssh:t@abc',
      platform: { os: 'linux', arch: 'x64' },
      probes: okMethod.probes
    })
    expect(calls.map((c) => c.method)).toEqual(['relay.status', 'environment.measureRequirements'])
    expect(calls[0].timeoutMs).toBe(15_000)
    expect(calls[1].timeoutMs).toBe(60_000)
  })

  it('sends the reduced requests and never a prepare text or description', async () => {
    const { measure, calls } = setup({ mux: 'live', status: okStatus, method: okMethod })
    await measure([
      { ...git, prepare: 'rm -rf /sentinel-prepare', description: 'sentinel-description' }
    ])
    const sent = JSON.stringify(calls[1].params)
    expect(sent).toContain('/home/u/project')
    expect(sent).not.toContain('sentinel')
  })

  it('is unreachable without a multiplexer or with a disposed one', async () => {
    expect(status(await setup({ mux: 'none' }).measure())).toBe('unreachable')
    expect(status(await setup({ mux: 'disposed' }).measure())).toBe('unreachable')
  })

  it('does not call without the capability', async () => {
    const { measure, calls } = setup({
      mux: 'live',
      status: { capabilities: ['skills.install.v1'] },
      method: okMethod
    })
    const result = await measure()
    expect(status(result)).toBe('host-predates-probes')
    expect(calls.some((c) => c.method === 'environment.measureRequirements')).toBe(false)
  })

  it('connection lost is unreachable', async () => {
    const { measure } = setup({
      mux: 'live',
      status: okStatus,
      method: codedError('CONNECTION_LOST')
    })
    expect(status(await measure())).toBe('unreachable')
  })

  it('a disposed channel during the call is unreachable', async () => {
    const { measure } = setup({ mux: 'live', status: okStatus, method: codedError('DISPOSED') })
    expect(status(await measure())).toBe('unreachable')
  })

  it('-32601 from the method is host-predates-probes', async () => {
    const { measure } = setup({ mux: 'live', status: okStatus, method: codedError(-32601) })
    expect(status(await measure())).toBe('host-predates-probes')
  })

  it('a request timeout is timed-out', async () => {
    const { measure } = setup({
      mux: 'live',
      status: okStatus,
      method: codedError('SSH_MUX_REQUEST_TIMEOUT')
    })
    expect(status(await measure())).toBe('timed-out')
  })

  it('another relay error is refused with its code, never measured', async () => {
    const { measure } = setup({ mux: 'live', status: okStatus, method: codedError(-32602) })
    const result = await measure()
    expect(result).toMatchObject({ status: 'refused' })
    expect(result.status === 'refused' && result.detail).toContain('-32602')
  })

  it('a malformed response is refused', async () => {
    for (const method of [
      null,
      'text',
      { platform: { os: 'linux' }, probes: [] },
      { platform: { os: 'linux', arch: 'x64' }, probes: 'nope' },
      { platform: { os: 'linux', arch: 'x64' }, probes: [{ id: 'git', outcome: 'maybe' }] },
      { platform: { os: 'linux', arch: 'x64' }, probes: [{ id: 'other', outcome: 'found' }] },
      {
        platform: { os: 'linux', arch: 'x64' },
        probes: [{ id: 'git', outcome: 'found', version: 'not a version' }]
      }
    ]) {
      const { measure } = setup({ mux: 'live', status: okStatus, method })
      const result = await measure()
      expect(result.status, JSON.stringify(method)).toBe('refused')
      expect(result.status === 'refused' && result.detail).toBe('malformed-response')
    }
  })

  it('strips fields the response schema does not declare', async () => {
    const { measure } = setup({
      mux: 'live',
      status: okStatus,
      method: {
        platform: { os: 'linux', arch: 'x64', extra: 1 },
        probes: [
          {
            id: 'git',
            outcome: 'found',
            version: '2.43.0',
            env: 'zz-sentinel-zz',
            stdout: 'zz-out'
          }
        ],
        extra: 'zz-sentinel-zz'
      }
    })
    const result = await measure()
    expect(result.status).toBe('measured')
    expect(JSON.stringify(result)).not.toContain('zz-')
  })

  it('names the requests beyond the cap instead of sending them', async () => {
    const rows: EnvironmentRequirement[] = Array.from({ length: 66 }, (_, i) => ({
      id: `e${i}`,
      kind: 'env',
      name: 'ORCA_X'
    }))
    const { measure, calls } = setup({
      mux: 'live',
      status: okStatus,
      method: { platform: { os: 'linux', arch: 'x64' }, probes: [] }
    })
    const result = await measure(rows)
    expect((calls[1].params as { requirements: unknown[] }).requirements).toHaveLength(64)
    expect(result.status === 'measured' && result.probes.map((p) => p.reason)).toEqual([
      'too-many-requirements',
      'too-many-requirements'
    ])
  })

  describe('the relay.status read', () => {
    it('status read lost is unreachable', async () => {
      const { measure, calls } = setup({
        mux: 'live',
        status: codedError('CONNECTION_LOST'),
        method: okMethod
      })
      expect(status(await measure())).toBe('unreachable')
      expect(calls.map((c) => c.method)).toEqual(['relay.status'])
    })

    it('a disposed channel on the status read is unreachable', async () => {
      const { measure } = setup({ mux: 'live', status: codedError('DISPOSED'), method: okMethod })
      expect(status(await measure())).toBe('unreachable')
    })

    it('a status timeout is timed-out and the method is not called', async () => {
      const { measure, calls } = setup({
        mux: 'live',
        status: codedError('SSH_MUX_REQUEST_TIMEOUT'),
        method: okMethod
      })
      expect(status(await measure())).toBe('timed-out')
      expect(calls).toHaveLength(1)
    })

    it('-32601 from relay.status is host-predates-probes', async () => {
      const { measure, calls } = setup({
        mux: 'live',
        status: codedError(-32601),
        method: okMethod
      })
      expect(status(await measure())).toBe('host-predates-probes')
      expect(calls).toHaveLength(1)
    })

    it.each([{}, { capabilities: 'x' }, { capabilities: [1, 2] }, null])(
      'a status payload without a string-array capabilities (%j) is host-predates-probes',
      async (payload) => {
        const { measure, calls } = setup({ mux: 'live', status: payload, method: okMethod })
        expect(status(await measure())).toBe('host-predates-probes')
        expect(calls).toHaveLength(1)
      }
    )
  })
})
