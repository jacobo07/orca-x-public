import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ReplicaCapsuleCreateResult,
  ReplicaCapsuleListResult,
  ReplicaCapsuleRestoreResult
} from '../../shared/replica-capsule-view'
import type { ReplicaPairCompareResult } from '../../shared/replica-pair-view'
import { formatCliError } from '../format'
import { RuntimeClientError, RuntimeRpcFailureError } from '../runtime-client'
import { PROJECT_REPLICA_HANDLERS } from './project-replica'

const meta = { runtimeId: 'runtime-1' }
const compare = PROJECT_REPLICA_HANDLERS['project replica-compare']!
const capsule = PROJECT_REPLICA_HANDLERS['project replica-capsule']!
const capsuleList = PROJECT_REPLICA_HANDLERS['project replica-capsule-list']!
const capsuleRestore = PROJECT_REPLICA_HANDLERS['project replica-capsule-restore']!

function context(
  call: ReturnType<typeof vi.fn>,
  flags: [string, string | boolean][],
  json = false
) {
  return { client: { call, isRemote: false }, cwd: '/repo', flags: new Map(flags), json } as never
}

function answer(
  result:
    | ReplicaPairCompareResult
    | ReplicaCapsuleCreateResult
    | ReplicaCapsuleListResult
    | ReplicaCapsuleRestoreResult
) {
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

const REF = `refs/orca/capsules/${'d'.repeat(40)}`
const planned: ReplicaCapsuleRestoreResult = {
  status: 'ok',
  outcome: {
    kind: 'plan',
    ref: REF,
    sha: 'd'.repeat(40),
    base: 'b'.repeat(40),
    partial: false,
    changes: { tracked: 2, staged: 1, untracked: 3 }
  }
}
const appliedResult: ReplicaCapsuleRestoreResult = {
  status: 'ok',
  outcome: {
    kind: 'applied',
    ref: REF,
    sha: 'd'.repeat(40),
    base: 'b'.repeat(40),
    partial: false,
    changes: { tracked: 2, staged: 1, untracked: 3 },
    verified: { worktree: 't', index: 'i', untracked: null },
    warnings: []
  }
}

describe('orca project replica-capsule', () => {
  it('calls projectReplica.capsuleCreate once with only the setup and prints the created ref', async () => {
    const call = answer({
      status: 'ok',
      outcome: {
        kind: 'created',
        ref: REF,
        sha: 'd'.repeat(40),
        base: 'b'.repeat(40),
        alreadyExisted: false,
        omissions: [],
        partial: false
      }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await capsule(context(call, [['setup', 's1']]))

    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith('projectReplica.capsuleCreate', { setupId: 's1' })
    expect(log).toHaveBeenCalledWith(`created ${REF} (base bbbbbbb)`)
    expect(process.exitCode).toBe(0)
  })

  it('requires --setup and sends nothing without it', async () => {
    const call = answer({ status: 'ok', outcome: { kind: 'clean' } })
    await expect(capsule(context(call, []))).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(call).not.toHaveBeenCalled()
  })

  it('exits 1 for a refusal; control: a clean worktree exits 0', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await capsule(context(answer({ status: 'refused', reason: 'worktree-busy' }), [['setup', 's']]))
    expect(process.exitCode).toBe(1)
    process.exitCode = undefined
    await capsule(context(answer({ status: 'ok', outcome: { kind: 'clean' } }), [['setup', 's']]))
    expect(process.exitCode).toBe(0)
  })

  it('names the local-setup requirement with the setup id for a remote setup', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await capsule(
      context(answer({ status: 'refused', reason: 'remote-capsule-unsupported' }), [
        ['setup', 'gex']
      ])
    )
    expect(String(log.mock.calls[0]![0])).toContain('gex')
    expect(String(log.mock.calls[0]![0])).toContain('local setup')
  })

  it('turns method_not_found into a named host-predates refusal; other errors pass through', async () => {
    const failure = await capsule(
      context(vi.fn().mockRejectedValue(methodNotFound()), [['setup', 's']])
    ).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'update_required' })
    expect(formatCliError(failure)).toContain(
      'this Orca host predates replica capsules; update the host'
    )
    const original = new Error('boom')
    const other = await capsule(
      context(vi.fn().mockRejectedValue(original), [['setup', 's']])
    ).catch((error: unknown) => error)
    expect(other).toBe(original)
  })
})

describe('orca project replica-capsule-list', () => {
  it('calls projectReplica.capsuleList and exits 1 when a capsule is damaged', async () => {
    const call = answer({
      status: 'ok',
      capsules: [{ ref: REF, damaged: true, reason: 'not-a-capsule' }]
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await capsuleList(context(call, [['setup', 's']]))

    expect(call).toHaveBeenCalledWith('projectReplica.capsuleList', { setupId: 's' })
    expect(log).toHaveBeenCalledWith(`damaged ${REF} (not-a-capsule)`)
    expect(process.exitCode).toBe(1)
  })

  it('control: only good capsules exit 0', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await capsuleList(
      context(
        answer({
          status: 'ok',
          capsules: [{ ref: REF, sha: 'd'.repeat(40), baseTip: 'b'.repeat(40), partial: false }]
        }),
        [['setup', 's']]
      )
    )
    expect(process.exitCode).toBe(0)
  })
})

describe('orca project replica-capsule-restore', () => {
  it('sends no apply without --apply and prints the plan with the re-run hint', async () => {
    const call = answer(planned)
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await capsuleRestore(
      context(call, [
        ['setup', 's'],
        ['capsule', REF]
      ])
    )

    expect(call).toHaveBeenCalledWith('projectReplica.capsuleRestore', {
      setupId: 's',
      capsule: REF
    })
    expect(String(log.mock.calls[0]![0])).toContain(
      'plan only; re-run with --apply to change the worktree'
    )
    expect(process.exitCode).toBe(0)
  })

  it('sends apply: true only with --apply and prints applied', async () => {
    const call = answer(appliedResult)
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await capsuleRestore(
      context(call, [
        ['setup', 's'],
        ['capsule', REF],
        ['apply', true]
      ])
    )

    expect(call).toHaveBeenCalledWith('projectReplica.capsuleRestore', {
      setupId: 's',
      capsule: REF,
      apply: true
    })
    expect(String(log.mock.calls[0]![0])).toContain('applied')
    expect(process.exitCode).toBe(0)
  })

  it('requires --capsule and sends nothing without it', async () => {
    const call = answer(planned)
    await expect(capsuleRestore(context(call, [['setup', 's']]))).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    expect(call).not.toHaveBeenCalled()
  })

  it('exits 1 for a failed restore and prints the recovery text verbatim', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const recovery = 'Your files are intact; the capsule is at refs/orca/capsules/x.'

    await capsuleRestore(
      context(
        answer({
          status: 'failed',
          reason: 'apply-failed',
          ref: REF,
          detail: 'git said no',
          recovery
        }),
        [
          ['setup', 's'],
          ['capsule', REF],
          ['apply', true]
        ]
      )
    )

    expect(String(log.mock.calls[0]![0])).toContain(recovery)
    expect(process.exitCode).toBe(1)
  })

  it('exits 1 for a refusal and prints its word', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await capsuleRestore(
      context(answer({ status: 'refused', reason: 'worktree-not-clean', detail: 'dirty' }), [
        ['setup', 's'],
        ['capsule', REF]
      ])
    )
    expect(String(log.mock.calls[0]![0])).toContain('worktree-not-clean')
    expect(process.exitCode).toBe(1)
  })

  it('--json prints the raw result and keeps the exit rule', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await capsuleRestore(
      context(
        answer({ status: 'refused', reason: 'capsule-unknown' }),
        [
          ['setup', 's'],
          ['capsule', REF]
        ],
        true
      )
    )
    expect(JSON.parse(String(log.mock.calls[0]![0])).result).toEqual({
      status: 'refused',
      reason: 'capsule-unknown'
    })
    expect(process.exitCode).toBe(1)
  })
})
