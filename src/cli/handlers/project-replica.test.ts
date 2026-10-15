import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReplicaPairCompareResult } from '../../shared/replica-pair-view'
import { formatCliError } from '../format'
import { RuntimeClientError, RuntimeRpcFailureError } from '../runtime-client'
import { PROJECT_REPLICA_HANDLERS } from './project-replica'

const meta = { runtimeId: 'runtime-1' }
const compare = PROJECT_REPLICA_HANDLERS['project replica-compare']!

function context(
  call: ReturnType<typeof vi.fn>,
  flags: [string, string | boolean][],
  json = false
) {
  return { client: { call, isRemote: false }, cwd: '/repo', flags: new Map(flags), json } as never
}

function answer(result: ReplicaPairCompareResult) {
  return vi.fn().mockResolvedValue({ id: 'r1', ok: true, result, _meta: meta })
}

function sameResult(healthy: boolean): ReplicaPairCompareResult {
  return {
    status: 'ok',
    pairs: [
      {
        setupId: 'setup-b',
        anchorSetupId: 'setup-a',
        hostId: 'ssh:gex44' as never,
        relation: { kind: 'same', observedTips: ['a'.repeat(40), 'a'.repeat(40)] },
        healthy
      }
    ]
  }
}

const cleanSame = sameResult(true)

const methodNotFound = () =>
  new RuntimeRpcFailureError({
    id: 'r1',
    ok: false,
    error: { code: 'method_not_found', message: 'Unknown method' },
    _meta: meta
  })

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
})

describe('orca project replica-compare', () => {
  it('calls projectReplica.compare once with only the project when --setup is absent', async () => {
    const call = answer(cleanSame)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await compare(context(call, [['project', 'github:acme/app']]))

    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith('projectReplica.compare', { projectId: 'github:acme/app' })
  })

  it('passes --setup through as setupId', async () => {
    const call = answer(cleanSame)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await compare(
      context(call, [
        ['project', 'github:acme/app'],
        ['setup', 'setup-b']
      ])
    )

    expect(call).toHaveBeenCalledWith('projectReplica.compare', {
      projectId: 'github:acme/app',
      setupId: 'setup-b'
    })
  })

  it('requires --project and sends nothing without it', async () => {
    const call = answer(cleanSame)
    await expect(compare(context(call, []))).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(call).not.toHaveBeenCalled()
  })

  it('prints the formatted relation and exits 0 for a verified-clean same pair', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await compare(context(answer(cleanSame), [['project', 'p']]))

    expect(log).toHaveBeenCalledWith('setup-b  ssh:gex44  same')
    expect(process.exitCode).toBe(0)
  })

  it('control: the same pair with healthy false prints unverified and exits 1', async () => {
    const unhealthy = sameResult(false)
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await compare(context(answer(unhealthy), [['project', 'p']]))

    expect(log).toHaveBeenCalledWith('setup-b  ssh:gex44  unverified (worktree-not-verified-clean)')
    expect(process.exitCode).toBe(1)
  })

  it('exits 1 for an empty service slot with the relay words', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await compare(
      context(answer({ status: 'unavailable', reason: 'no-replica-service' }), [['project', 'p']])
    )

    expect(String(log.mock.calls[0]![0])).toContain('no SSH relay session')
    expect(process.exitCode).toBe(1)
  })

  it('--json prints the raw result envelope and still sets the exit code from the pairs', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await compare(
      context(answer({ status: 'refused', reason: 'remote-caller' }), [['project', 'p']], true)
    )

    const printed = JSON.parse(String(log.mock.calls[0]![0]))
    expect(printed.result).toEqual({ status: 'refused', reason: 'remote-caller' })
    expect(process.exitCode).toBe(1)
  })

  it('turns method_not_found into a named host-predates refusal', async () => {
    const call = vi.fn().mockRejectedValue(methodNotFound())

    const failure = await compare(context(call, [['project', 'p']])).catch(
      (error: unknown) => error
    )

    expect(failure).toBeInstanceOf(RuntimeClientError)
    expect(failure).toMatchObject({ code: 'update_required' })
    expect(formatCliError(failure)).toContain(
      'this Orca host predates replica compare; update the host'
    )
  })

  it('control: any other error code is rethrown unchanged', async () => {
    const original = new RuntimeRpcFailureError({
      id: 'r1',
      ok: false,
      error: { code: 'runtime_error', message: 'boom' },
      _meta: meta
    })
    const call = vi.fn().mockRejectedValue(original)

    const failure = await compare(context(call, [['project', 'p']])).catch(
      (error: unknown) => error
    )

    expect(failure).toBe(original)
  })
})
