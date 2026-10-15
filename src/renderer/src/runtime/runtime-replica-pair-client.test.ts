import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ReplicaPairCompareResult,
  ReplicaPairRelationsResult
} from '../../../shared/replica-pair-view'
import { compareReplicaPairs, readReplicaRelations } from './runtime-replica-pair-client'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from '../web/web-preload-api-test-harness'

describe('web preload replicaPair block', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('../web/web-runtime-client')
  })

  it('answers refused/remote-caller without sending any runtime request', async () => {
    const send = vi.fn(async (method: string) => ({
      id: method,
      ok: true,
      result: { measurement: 'x' },
      _meta: { runtimeId: 'runtime-1' }
    }))
    vi.doMock('../web/web-runtime-client', () => ({
      WebRuntimeClient: class {
        call = send
        close(): void {}
      }
    }))
    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage, 'web-server-a')
    const { installWebPreloadApi } = await import('../web/web-preload-api')
    installWebPreloadApi()
    const refused = { status: 'refused', reason: 'remote-caller' }

    await expect(globals.window.api.replicaPair.compare({ projectId: 'p1' })).resolves.toEqual(
      refused
    )
    await expect(globals.window.api.replicaPair.relations()).resolves.toEqual(refused)
    expect(send).not.toHaveBeenCalled()

    // Control: a sibling web method does reach the recorded client, so the spy can observe a request.
    await globals.window.api.environment.measureRequirements({ repoId: 'r1' })
    expect(send).toHaveBeenCalledWith(
      'environment.measureRequirements',
      expect.anything(),
      expect.anything()
    )
  })
})

const compare = vi.fn()
const relations = vi.fn()
const remote = { kind: 'environment', environmentId: 'env-1' } as const
const refused = { status: 'refused', reason: 'remote-caller' }
const compareAnswer: ReplicaPairCompareResult = {
  status: 'ok',
  pairs: [
    {
      setupId: 's2',
      anchorSetupId: 's1',
      hostId: 'ssh:box',
      relation: { kind: 'unknown', reason: 'not-compared' },
      healthy: false
    }
  ]
}
const relationsAnswer: ReplicaPairRelationsResult = { status: 'ok', pairs: [] }

describe('replica pair client', () => {
  beforeEach(() => {
    compare.mockReset()
    relations.mockReset()
    vi.stubGlobal('window', { api: { replicaPair: { compare, relations } } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reaches the desktop IPC once for a local target and returns the answer unchanged', async () => {
    compare.mockResolvedValueOnce(compareAnswer)
    relations.mockResolvedValueOnce(relationsAnswer)

    await expect(compareReplicaPairs({ kind: 'local' }, 'p1', 's2')).resolves.toBe(compareAnswer)
    await expect(readReplicaRelations({ kind: 'local' })).resolves.toBe(relationsAnswer)

    expect(compare).toHaveBeenCalledExactlyOnceWith({ projectId: 'p1', setupId: 's2' })
    expect(relations).toHaveBeenCalledOnce()
  })

  it('omits setupId from the request when none is given', async () => {
    compare.mockResolvedValueOnce(compareAnswer)

    await compareReplicaPairs({ kind: 'local' }, 'p1')

    expect(compare.mock.calls[0][0]).toStrictEqual({ projectId: 'p1' })
  })

  it('answers refused/remote-caller for a remote target without calling the IPC', async () => {
    await expect(compareReplicaPairs(remote, 'p1')).resolves.toEqual(refused)
    await expect(readReplicaRelations(remote)).resolves.toEqual(refused)

    expect(compare).not.toHaveBeenCalled()
    expect(relations).not.toHaveBeenCalled()
  })

  it('rethrows a rejected IPC call unchanged instead of answering an empty list', async () => {
    const failure = new Error('ipc channel closed')
    compare.mockRejectedValueOnce(failure)
    relations.mockRejectedValueOnce(failure)

    await expect(compareReplicaPairs({ kind: 'local' }, 'p1')).rejects.toBe(failure)
    await expect(readReplicaRelations({ kind: 'local' })).rejects.toBe(failure)
  })

  it('passes every closed arm through and rethrows an unknown status', async () => {
    const arms = [
      { status: 'unavailable', reason: 'no-replica-service' },
      { status: 'not-found', reason: 'unknown-project' },
      refused
    ]
    for (const arm of arms) {
      compare.mockResolvedValueOnce(arm)
      await expect(compareReplicaPairs({ kind: 'local' }, 'p1')).resolves.toEqual(arm)
    }

    compare.mockResolvedValueOnce({ status: 'degraded', pairs: [] })
    relations.mockResolvedValueOnce({ status: 'not-found', reason: 'unknown-project' })
    relations.mockResolvedValueOnce(undefined)

    await expect(compareReplicaPairs({ kind: 'local' }, 'p1')).rejects.toThrow(
      'Unexpected replica pair status: degraded'
    )
    // not-found is a compare-only arm, so a relations answer carrying it is a shape this client does not know.
    await expect(readReplicaRelations({ kind: 'local' })).rejects.toThrow(
      'Unexpected replica pair status: not-found'
    )
    await expect(readReplicaRelations({ kind: 'local' })).rejects.toThrow(
      'Unexpected replica pair status: undefined'
    )

    // An ok answer without a pair array is never turned into an empty one.
    compare.mockResolvedValueOnce({ status: 'ok' })
    await expect(compareReplicaPairs({ kind: 'local' }, 'p1')).rejects.toThrow('without pairs')
  })
})
