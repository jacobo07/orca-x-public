import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FleetObservation } from '../../../../shared/fleet-placement-view'
import type { FleetPlacementMember } from '../../../../shared/fleet-placement'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_CONTRACT_VERSION,
  ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import type { OrchestrationDb } from '../../orchestration/db'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { ORCHESTRATION_METHODS } from './orchestration'
import { createOrchestrationRpcHarness } from './orchestration-rpc-test-harness'

const observation = vi.hoisted(() => ({ current: null as Promise<unknown> | null }))
vi.mock('../../../fleet/fleet-observation-slot', () => ({
  readFleetObservation: () => observation.current,
  installFleetObservation: () => {}
}))

function member(
  address: FleetPlacementMember['address'],
  fingerprint: string,
  capabilities: string[] | null,
  availableMemory: number
): FleetPlacementMember {
  return {
    address,
    label: address,
    identity: { state: 'keyed', fingerprint },
    facts: { runtimeId: null, platform: 'linux', capabilities, protocol: 'not-applicable' },
    sample: {
      outcome: 'measured',
      runtimeId: null,
      startedAt: 1_000,
      totalMemory: availableMemory,
      availableMemory,
      availableMemorySource: 'unknown',
      processSweep: 'unknown'
    }
  }
}

const FED = [ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY, ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY]

function fleet(): FleetObservation {
  return {
    observedAt: 1_000,
    completedAt: 1_000,
    members: [
      member('local', 'fp-win', null, 4),
      member('ssh:gex', 'ssh-hostkey:x', null, 64),
      member('runtime:env-gex', 'fp-gex', FED, 32)
    ],
    coverage: { runtimeEnvironments: 1, sshTargets: 'enumerated' }
  }
}

async function codeOf(run: Promise<unknown>): Promise<string | undefined> {
  try {
    await run
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  }
}

describe('cross-host mission dispatch', () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext

  function setup(): void {
    ;({ db, runtime, ctx } = h.setup(true))
    observation.current = Promise.resolve(fleet())
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockImplementation((selector) => ({
      environmentId: selector === 'gex' ? 'env-gex' : `env-${selector}`,
      name: selector,
      peerFingerprint: 'fp-gex'
    }))
  }

  afterEach(() => {
    observation.current = null
    h.cleanup()
  })

  it('places one job on this host and one on the runtime, never the SSH relay', async () => {
    setup()
    const a = db.createTask({ spec: 'job a' })
    const b = db.createTask({ spec: 'job b' })
    const plan = (await h.call(
      'orchestration.missionPlace',
      { from: 'term_coord', tasks: [a.id, b.id] },
      ctx
    )) as {
      hostCount: number
      placements: { address: string }[]
      notDispatchable: { address: string }[]
    }
    expect(plan.hostCount).toBe(2)
    expect(plan.placements.map((p) => p.address).sort()).toEqual(['local', 'runtime:env-gex'])
    expect(plan.notDispatchable.map((m) => m.address)).toEqual(['ssh:gex'])
    expect(db.listRunTaskPlacements(a.run_id)).toHaveLength(2)
  })

  describe('resource requirement', () => {
    const GB = 1024 ** 3
    type PlaceResult = {
      placements: { taskId: string; address: string; fingerprint: string }[]
      unplaced: { jobId: string }[]
    }

    // Why: three dispatchable hosts; the 6 GiB runtime is third in the memory ranking, so only a requirement keeps it empty.
    function useResourceFleet(): void {
      observation.current = Promise.resolve({
        ...fleet(),
        members: [
          member('local', 'fp-win', null, 16 * GB),
          member('runtime:env-big', 'fp-big', FED, 24 * GB),
          member('runtime:env-small', 'fp-small', FED, 6 * GB)
        ]
      })
    }

    it('places a task needing 8 GiB on a host that has it and persists that host', async () => {
      setup()
      useResourceFleet()
      const a = db.createTask({ spec: 'heavy' })
      const plan = (await h.call(
        'orchestration.missionPlace',
        {
          from: 'term_coord',
          tasks: [a.id],
          requirement: { memory: { minAvailableBytes: 8 * GB } }
        },
        ctx
      )) as PlaceResult
      expect(plan.unplaced).toEqual([])
      expect(db.getTaskPlacement(a.id)).toMatchObject({
        fingerprint: 'fp-big',
        address: 'runtime:env-big',
        label: 'runtime:env-big'
      })
    })

    it('keeps every heavy task off the 6 GiB host even when it must double up', async () => {
      setup()
      useResourceFleet()
      const ids = ['a', 'b', 'c'].map((spec) => db.createTask({ spec }).id)
      await h.call(
        'orchestration.missionPlace',
        {
          from: 'term_coord',
          tasks: ids,
          requirement: { memory: { minAvailableBytes: 8 * GB } }
        },
        ctx
      )
      const rows = ids.map((id) => db.getTaskPlacement(id))
      expect(rows.every((row) => row !== undefined)).toBe(true)
      expect(rows.map((row) => row?.fingerprint)).not.toContain('fp-small')
      expect(new Set(rows.map((row) => row?.fingerprint))).toEqual(new Set(['fp-big', 'fp-win']))
    })

    it('control: without a requirement the third task lands on the 6 GiB host', async () => {
      setup()
      useResourceFleet()
      const ids = ['a', 'b', 'c'].map((spec) => db.createTask({ spec }).id)
      const plan = (await h.call(
        'orchestration.missionPlace',
        { from: 'term_coord', tasks: ids },
        ctx
      )) as PlaceResult
      expect(plan.unplaced).toEqual([])
      expect(ids.map((id) => db.getTaskPlacement(id)?.fingerprint).sort()).toEqual([
        'fp-big',
        'fp-small',
        'fp-win'
      ])
    })

    it('stays strict: an unknown requirement key or family key fails, nothing is placed', async () => {
      setup()
      useResourceFleet()
      const a = db.createTask({ spec: 'job a' })
      for (const requirement of [
        { cpu: { cores: 4 } },
        { memory: { minAvailableBytes: 1, x: 1 } }
      ]) {
        await expect(
          h.call(
            'orchestration.missionPlace',
            { from: 'term_coord', tasks: [a.id], requirement },
            ctx
          )
        ).rejects.toThrow(/Unrecognized key/)
      }
      expect(db.getTaskPlacement(a.id)).toBeUndefined()
    })

    it('still refuses a remote caller and a task that already left pending/ready', async () => {
      setup()
      useResourceFleet()
      const a = db.createTask({ spec: 'job a' })
      const requirement = { memory: { minAvailableBytes: 8 * GB } }
      expect(
        await codeOf(
          h.call(
            'orchestration.missionPlace',
            { from: 'term_coord', tasks: [a.id], requirement },
            { ...ctx, pairedDeviceId: 'phone' }
          )
        )
      ).toBe('remote_caller_refused')
      db.updateTaskStatus(a.id, 'completed', 'done')
      expect(
        await codeOf(
          h.call(
            'orchestration.missionPlace',
            { from: 'term_coord', tasks: [a.id], requirement },
            ctx
          )
        )
      ).toBe('task_not_placeable')
    })
  })

  it('refuses a remote caller and an unbound coordinator', async () => {
    setup()
    const a = db.createTask({ spec: 'job a' })
    expect(
      await codeOf(
        h.call(
          'orchestration.missionPlace',
          { from: 'term_coord', tasks: [a.id] },
          { ...ctx, pairedDeviceId: 'phone' }
        )
      )
    ).toBe('remote_caller_refused')
    expect(
      await codeOf(h.call('orchestration.missionPlace', { from: 'term_other', tasks: [a.id] }, ctx))
    ).toBe('consumer_fenced')
    expect(db.getTaskPlacement(a.id)).toBeUndefined()
  })

  // Why: the dispatcher stamps a local caller fingerprint on every mutation; the live leg was refused by it.
  it('admits the local socket through the real dispatcher and refuses a paired socket', async () => {
    setup()
    const a = db.createTask({ spec: 'job a' })
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    const request = (id: string) => ({
      id,
      authToken: 'test-auth-token',
      method: 'orchestration.missionPlace',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: `place-${id}`,
      params: { from: 'term_coord', tasks: [a.id] }
    })
    const replies: string[] = []
    await dispatcher.dispatchStreaming(request('paired'), (r) => replies.push(r), {
      authenticatedCallerFingerprint: 'fp-phone',
      clientId: 'device-token',
      pairedDeviceId: 'phone',
      clientKind: 'runtime'
    })
    expect(JSON.parse(replies[0]).error).toMatchObject({ code: 'remote_caller_refused' })
    // A fingerprint that is not this runtime's own still marks a remote caller.
    expect(
      await codeOf(
        h.call(
          'orchestration.missionPlace',
          { from: 'term_coord', tasks: [a.id] },
          { ...ctx, authenticatedCallerFingerprint: 'fp-foreign' }
        )
      )
    ).toBe('remote_caller_refused')
    const local = await dispatcher.dispatch(request('local'))
    expect(local.ok ? undefined : local.error).toBeUndefined()
    expect(db.getTaskPlacement(a.id)).toBeDefined()
  })

  it('workerStart refuses a placed task started on the wrong host before any dispatch row', async () => {
    setup()
    const a = db.createTask({ spec: 'job a' })
    const b = db.createTask({ spec: 'job b' })
    db.placeMissionTasks(a.run_id, [
      {
        taskId: a.id,
        hostKey: 'fingerprint:fp-win',
        fingerprint: 'fp-win',
        address: 'local',
        label: 'laptop'
      },
      {
        taskId: b.id,
        hostKey: 'fingerprint:fp-gex',
        fingerprint: 'fp-gex',
        address: 'runtime:env-gex',
        label: 'gex44'
      }
    ])
    const createTerminal = vi.spyOn(runtime, 'createTerminal')
    expect(
      await codeOf(
        h.call('orchestration.workerStart', { task: a.id, from: 'term_coord', on: 'gex' }, ctx)
      )
    ).toBe('placement_mismatch')
    expect(
      await codeOf(
        h.call('orchestration.workerStart', { task: b.id, from: 'term_coord', agent: 'codex' }, ctx)
      )
    ).toBe('placement_mismatch')
    expect(
      await codeOf(
        h.call('orchestration.workerStart', { task: b.id, from: 'term_coord', on: 'other' }, ctx)
      )
    ).toBe('placement_mismatch')
    expect(db.getDispatchContext(a.id)).toBeUndefined()
    expect(db.getDispatchContext(b.id)).toBeUndefined()
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('workerStart lets the placed remote host through to the federation start', async () => {
    setup()
    const b = db.createTask({ spec: 'job b' })
    db.placeMissionTasks(b.run_id, [
      {
        taskId: b.id,
        hostKey: 'fingerprint:fp-gex',
        fingerprint: 'fp-gex',
        address: 'runtime:env-gex',
        label: 'gex44'
      }
    ])
    // Why: past the placement check, federation's own guard refuses a call with no retry identity.
    expect(
      await codeOf(
        h.call(
          'orchestration.workerStart',
          { task: b.id, from: 'term_coord', on: 'gex', worktree: 'new-top-level' },
          ctx
        )
      )
    ).toBe('invalid_argument')
  })

  it('missionPlace refuses a task that already left pending/ready', async () => {
    setup()
    const a = db.createTask({ spec: 'job a' })
    db.updateTaskStatus(a.id, 'completed', 'done before any placement')
    expect(
      await codeOf(h.call('orchestration.missionPlace', { from: 'term_coord', tasks: [a.id] }, ctx))
    ).toBe('task_not_placeable')
    expect(db.getTaskPlacement(a.id)).toBeUndefined()
  })

  it('missionResults never credits a placed host whose dispatch did not run there', async () => {
    setup()
    const a = db.createTask({ spec: 'job a' })
    const b = db.createTask({ spec: 'job b' })
    db.placeMissionTasks(a.run_id, [
      {
        taskId: a.id,
        hostKey: 'fingerprint:fp-win',
        fingerprint: 'fp-win',
        address: 'local',
        label: 'laptop'
      },
      {
        taskId: b.id,
        hostKey: 'fingerprint:fp-gex',
        fingerprint: 'fp-gex',
        address: 'runtime:env-gex',
        label: 'gex44'
      }
    ])
    db.createDispatchContext(a.id, 'term_worker_a')
    db.updateTaskStatus(a.id, 'completed', 'a done')
    // Why: b completes with no dispatch at all, the way a manual task-update would.
    db.updateTaskStatus(b.id, 'completed', 'b done')
    const r = (await h.call('orchestration.missionResults', { run: a.run_id }, ctx)) as {
      crossHost: boolean
      completed: number
      pending: string[]
      jobs: { jobId: string; ranOnPlacement: boolean; completedAt: string | null }[]
    }
    expect(r.completed).toBe(1)
    expect(r.crossHost).toBe(false)
    expect(r.pending).toEqual([b.id])
    expect(r.jobs.find((j) => j.jobId === a.id)?.ranOnPlacement).toBe(true)
    expect(r.jobs.find((j) => j.jobId === b.id)?.ranOnPlacement).toBe(false)
  })
})
