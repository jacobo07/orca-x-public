import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ReplicaCapsuleCreateResult,
  ReplicaCapsuleListResult,
  ReplicaCapsuleRestoreResult
} from '../../shared/replica-capsule-view'
import type { ReplicaPairCompareResult } from '../../shared/replica-pair-view'
import type {
  ReplicaPreserveDivergenceResult,
  ReplicaReconcileResult,
  ReplicaSyncResult
} from '../../shared/replica-sync-view'
import { parseArgs, validateCommandAndFlags } from '../args'
import { formatCliError } from '../format'
import { RuntimeClientError, RuntimeRpcFailureError } from '../runtime-client'
import { PROJECT_REPLICA_COMMAND_SPECS } from '../specs/project-replica'
import { PROJECT_REPLICA_HANDLERS } from './project-replica'

const meta = { runtimeId: 'runtime-1' }
const compare = PROJECT_REPLICA_HANDLERS['project replica-compare']!
const capsule = PROJECT_REPLICA_HANDLERS['project replica-capsule']!
const capsuleList = PROJECT_REPLICA_HANDLERS['project replica-capsule-list']!
const capsuleRestore = PROJECT_REPLICA_HANDLERS['project replica-capsule-restore']!
const syncVerb = PROJECT_REPLICA_HANDLERS['project replica-sync']!
const preserveVerb = PROJECT_REPLICA_HANDLERS['project replica-preserve-divergence']!
const reconcileVerb = PROJECT_REPLICA_HANDLERS['project replica-reconcile']!

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
    | ReplicaSyncResult
    | ReplicaPreserveDivergenceResult
    | ReplicaReconcileResult
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

const FROM = '1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const TO = '2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

describe('orca project replica-sync', () => {
  const run = async (result: ReplicaSyncResult, json = false) => {
    const call = answer(result)
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await syncVerb(context(call, [['setup', 'setup-b']], json))
    return { call, printed: String(log.mock.calls[0]![0]) }
  }

  it('calls projectReplica.sync once with only the setup id and exits 0 for a real sync', async () => {
    const { call, printed } = await run({
      status: 'ok',
      from: FROM,
      to: TO,
      capsuleRef: 'refs/orca/capsules/x'
    })
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith('projectReplica.sync', { setupId: 'setup-b' })
    expect(printed).toBe('synced 1111111..2222222; previous state saved as refs/orca/capsules/x')
    expect(process.exitCode).toBe(0)
  })

  it('prints a different sentence for a full disk, a lost connection and a stale generation, all exit 1', async () => {
    const printed: string[] = []
    for (const result of [
      { status: 'failed', reason: 'compare-transfer-interrupted', cause: 'disk-full' },
      { status: 'failed', reason: 'compare-transfer-interrupted' },
      { status: 'failed', reason: 'stale-generation' }
    ] as ReplicaSyncResult[]) {
      process.exitCode = undefined
      printed.push((await run(result)).printed)
      expect(process.exitCode, JSON.stringify(result)).toBe(1)
      vi.restoreAllMocks()
    }
    expect(printed[0]).toContain('disk is full')
    expect(printed[1]).toContain('connection to the host was lost')
    expect(printed[2]).toContain('connection changed')
    expect(new Set(printed).size).toBe(3)
  })

  it('a not-behind failure exits 1 and says what the pair is', async () => {
    const { printed } = await run({
      status: 'failed',
      reason: 'not-behind',
      observedAncestry: 'same'
    })
    expect(printed).toBe('nothing to sync: the replica is same')
    expect(process.exitCode).toBe(1)
  })

  it('--json prints the raw result and keeps the exit rule', async () => {
    const failed = await run({ status: 'refused', reason: 'worktree-busy' }, true)
    expect(JSON.parse(failed.printed).result).toEqual({
      status: 'refused',
      reason: 'worktree-busy'
    })
    expect(process.exitCode).toBe(1)
    vi.restoreAllMocks()
    process.exitCode = undefined
    const good = await run({ status: 'ok', from: FROM, to: TO }, true)
    expect(JSON.parse(good.printed).result.status).toBe('ok')
    expect(process.exitCode).toBe(0)
  })

  it('needs --setup and does not call the host without it', async () => {
    const call = answer({ status: 'ok', from: FROM, to: TO })
    const failure = await syncVerb(context(call, [])).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'invalid_argument' })
    expect(call).not.toHaveBeenCalled()
  })

  it('turns method_not_found into a named host-predates refusal; other errors pass through', async () => {
    const failure = await syncVerb(
      context(vi.fn().mockRejectedValue(methodNotFound()), [['setup', 's']])
    ).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'update_required' })
    expect(formatCliError(failure)).toContain(
      'this Orca host predates replica sync; update the host'
    )
    const original = new RuntimeRpcFailureError({
      id: 'r1',
      ok: false,
      error: { code: 'runtime_error', message: 'boom' },
      _meta: meta
    })
    const other = await syncVerb(
      context(vi.fn().mockRejectedValue(original), [['setup', 's']])
    ).catch((error: unknown) => error)
    expect(other).toBe(original)
  })
})

describe('orca project replica-preserve-divergence', () => {
  const refs = { local: 'refs/orca/divergence/l', remote: 'refs/orca/divergence/r' }

  it('calls projectReplica.preserveDivergence once with only the setup id', async () => {
    const call = answer({
      status: 'ok',
      refs,
      mergeBase: FROM,
      conflict: { kind: 'clean' },
      alreadyPreserved: false
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await preserveVerb(context(call, [['setup', 'setup-b']]))
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith('projectReplica.preserveDivergence', { setupId: 'setup-b' })
    expect(String(log.mock.calls[0]![0])).toContain('conflict: none')
    expect(process.exitCode).toBe(0)
  })

  it('an unknown conflict never prints none; not-diverged and refusals exit 1', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await preserveVerb(
      context(
        answer({
          status: 'ok',
          refs,
          mergeBase: FROM,
          conflict: { kind: 'unknown', reason: 'merge-tree-failed' },
          alreadyPreserved: false
        }),
        [['setup', 's']]
      )
    )
    expect(String(log.mock.calls[0]![0])).toContain('could not be determined')
    expect(String(log.mock.calls[0]![0])).not.toContain('none')
    expect(process.exitCode).toBe(0)
    await preserveVerb(
      context(answer({ status: 'refused', reason: 'not-diverged', relation: 'same' }), [
        ['setup', 's']
      ])
    )
    expect(String(log.mock.calls[1]![0])).toBe('the pair is not diverged (same)')
    expect(process.exitCode).toBe(1)
  })

  it('--json prints the raw result; method_not_found is a named refusal with a rethrow control', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await preserveVerb(
      context(answer({ status: 'failed', reason: 'tip-missing' }), [['setup', 's']], true)
    )
    expect(JSON.parse(String(log.mock.calls[0]![0])).result).toEqual({
      status: 'failed',
      reason: 'tip-missing'
    })
    expect(process.exitCode).toBe(1)
    const failure = await preserveVerb(
      context(vi.fn().mockRejectedValue(methodNotFound()), [['setup', 's']])
    ).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'update_required' })
    expect(formatCliError(failure)).toContain(
      'this Orca host predates replica sync; update the host'
    )
    const original = new Error('boom')
    const other = await preserveVerb(
      context(vi.fn().mockRejectedValue(original), [['setup', 's']])
    ).catch((error: unknown) => error)
    expect(other).toBe(original)
  })

  it('needs --setup and does not call the host without it', async () => {
    const call = vi.fn()
    await expect(preserveVerb(context(call, []))).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    expect(call).not.toHaveBeenCalled()
  })
})

describe('orca project replica-reconcile', () => {
  const CAPSULE = 'f'.repeat(40)
  const flags: [string, string][] = [
    ['setup', 'setup-b'],
    ['remote-capsule', CAPSULE]
  ]
  const ok: ReplicaReconcileResult = {
    status: 'ok',
    base: FROM,
    tree: 'e'.repeat(40),
    commit: '4444444cccccccccccccccccccccccccccccccc',
    ref: 'refs/orca/reconciled/a-b',
    localCapsuleRef: 'refs/orca/capsules/x',
    localOmissions: [],
    untrackedNotReconciled: false
  }

  it('calls projectReplica.reconcile once with the setup id and the capsule string unchanged', async () => {
    const call = answer(ok)
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await reconcileVerb(context(call, flags))
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith('projectReplica.reconcile', {
      setupId: 'setup-b',
      remoteCapsule: CAPSULE
    })
    expect(String(log.mock.calls[0]![0])).toContain('HEAD and the working tree were not changed')
    expect(process.exitCode).toBe(0)
  })

  it('forwards a hostile-looking value as an opaque string; building nothing from it', async () => {
    const call = answer({ status: 'refused', reason: 'invalid-input' })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await reconcileVerb(
      context(call, [
        ['setup', 's'],
        ['remote-capsule', '--upload-pack=x']
      ])
    )
    expect(call).toHaveBeenCalledWith('projectReplica.reconcile', {
      setupId: 's',
      remoteCapsule: '--upload-pack=x'
    })
    expect(process.exitCode).toBe(1)
  })

  it('unknown-commit tells the user to fetch; local-clean, conflict and merge-tree-unsupported exit 1', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const printed: string[] = []
    for (const result of [
      { status: 'refused', reason: 'unknown-commit' },
      { status: 'refused', reason: 'local-clean' },
      { status: 'refused', reason: 'merge-tree-unsupported' },
      { status: 'failed', reason: 'conflict', base: FROM, conflictedPaths: ['b', 'a'] }
    ] as ReplicaReconcileResult[]) {
      process.exitCode = undefined
      await reconcileVerb(context(answer(result), flags))
      expect(process.exitCode, JSON.stringify(result)).toBe(1)
      printed.push(String(log.mock.calls.at(-1)![0]))
    }
    expect(printed[0]).toContain('fetch')
    expect(printed[0]).toContain('fffffff')
    expect(printed[1]).toContain('replica-sync')
    expect(printed[2]).toContain('too old')
    expect(printed[3]).toContain('a')
    expect(new Set(printed).size).toBe(4)
  })

  it('needs --remote-capsule: exits via a usage error and never calls the host; control: with it the host is called', async () => {
    const call = answer(ok)
    const failure = await reconcileVerb(context(call, [['setup', 's']])).catch(
      (error: unknown) => error
    )
    expect(failure).toMatchObject({ code: 'invalid_argument' })
    expect(formatCliError(failure)).toContain('--remote-capsule')
    expect(formatCliError(failure)).toContain(
      'orca project replica-reconcile --setup <setup-id> --remote-capsule <sha>'
    )
    expect(call).not.toHaveBeenCalled()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await reconcileVerb(context(call, flags))
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('a bare --remote-capsule flag (no value) is a missing value, not the string true', async () => {
    const call = answer(ok)
    const failure = await reconcileVerb(
      context(call, [
        ['setup', 's'],
        ['remote-capsule', true]
      ])
    ).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'invalid_argument' })
    expect(call).not.toHaveBeenCalled()
  })

  it('--json prints the raw result and keeps the exit rule; method_not_found is named with a rethrow control', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await reconcileVerb(context(answer({ status: 'refused', reason: 'local-clean' }), flags, true))
    expect(JSON.parse(String(log.mock.calls[0]![0])).result).toEqual({
      status: 'refused',
      reason: 'local-clean'
    })
    expect(process.exitCode).toBe(1)
    const failure = await reconcileVerb(
      context(vi.fn().mockRejectedValue(methodNotFound()), flags)
    ).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'update_required' })
    expect(formatCliError(failure)).toContain(
      'this Orca host predates replica sync; update the host'
    )
    const original = new Error('boom')
    await expect(reconcileVerb(context(vi.fn().mockRejectedValue(original), flags))).rejects.toBe(
      original
    )
  })
})

describe('replica sync verbs on the command line', () => {
  it('parse and validate: --remote-capsule takes its value, --json does not, and an unknown flag is rejected', () => {
    const argv = [
      'project',
      'replica-reconcile',
      '--setup',
      's',
      '--remote-capsule',
      'a'.repeat(40),
      '--json'
    ]
    const parsed = parseArgs(argv)
    expect(parsed.flags.get('remote-capsule')).toBe('a'.repeat(40))
    expect(parsed.flags.get('setup')).toBe('s')
    expect(() => validateCommandAndFlags(PROJECT_REPLICA_COMMAND_SPECS, parsed)).not.toThrow()
    for (const verb of ['replica-sync', 'replica-preserve-divergence']) {
      const plain = parseArgs(['project', verb, '--setup', 's', '--json'])
      expect(
        () => validateCommandAndFlags(PROJECT_REPLICA_COMMAND_SPECS, plain),
        verb
      ).not.toThrow()
      // Control: --remote-capsule belongs to reconcile only.
      const stray = parseArgs(['project', verb, '--setup', 's', '--remote-capsule', 'x'])
      expect(() => validateCommandAndFlags(PROJECT_REPLICA_COMMAND_SPECS, stray), verb).toThrow(
        /Unknown flag/
      )
    }
  })
})
