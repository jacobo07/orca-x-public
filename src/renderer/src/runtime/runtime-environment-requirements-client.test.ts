import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnvironmentRequirementsMeasurement } from '../../../shared/environment-requirements-measurement'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from './runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'
import {
  measureRequirementsForRuntimeTarget,
  runPrepareStepForRuntimeTarget
} from './runtime-environment-requirements-client'

const measurement: EnvironmentRequirementsMeasurement = {
  contractSource: null,
  contract: 'absent',
  requirements: [],
  diagnostics: [],
  measurement: {
    status: 'measured',
    at: 1,
    hostKey: 'local@abc',
    platform: { os: 'linux', arch: 'x64' },
    probes: []
  }
}

const measureRequirements = vi.fn()
const runPrepareStep = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const remote = { kind: 'environment', environmentId: 'env-1' } as const

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  measureRequirements.mockReset()
  runPrepareStep.mockReset()
  runtimeEnvironmentCall.mockReset()
  vi.stubGlobal('window', {
    api: {
      environment: { measureRequirements, runPrepareStep },
      runtimeEnvironments: {
        call: (args: RuntimeEnvironmentCallRequest) =>
          createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
      }
    }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('measureRequirementsForRuntimeTarget', () => {
  it('asks the local host through IPC for a local target', async () => {
    measureRequirements.mockResolvedValueOnce(measurement)
    await expect(measureRequirementsForRuntimeTarget({ kind: 'local' }, 'r1')).resolves.toEqual({
      status: 'measured',
      result: measurement
    })
    expect(measureRequirements).toHaveBeenCalledWith({ repoId: 'r1' })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('asks the remote runtime by repo id for an environment target', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({ id: 'x', ok: true, result: measurement })
    const outcome = await measureRequirementsForRuntimeTarget(remote, 'r1')
    expect(outcome).toEqual({ status: 'measured', result: measurement })
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'environment.measureRequirements',
        params: { repo: 'id:r1' }
      })
    )
    expect(measureRequirements).not.toHaveBeenCalled()
  })

  it('old runtime is host-predates-probes', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'x',
      ok: false,
      error: { code: 'method_not_found', message: 'Unknown method' }
    })
    await expect(measureRequirementsForRuntimeTarget(remote, 'r1')).resolves.toEqual({
      status: 'host-predates-probes',
      detail: 'method-not-found'
    })
  })

  it('any other failure is rethrown, never read as an old host', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'x',
      ok: false,
      error: { code: 'repo_not_found', message: 'repo_not_found' }
    })
    await expect(measureRequirementsForRuntimeTarget(remote, 'r1')).rejects.toMatchObject({
      code: 'repo_not_found'
    })
  })
})

const APPROVAL = {
  requirementId: 'node',
  approvedContentHash: 'c'.repeat(64),
  approvedHostKey: 'local@abc'
}

describe('runPrepareStepForRuntimeTarget', () => {
  it('asks the local host through IPC and sends no command text', async () => {
    runPrepareStep.mockResolvedValueOnce({ status: 'started', terminal: { handle: 'h' } })
    await expect(
      runPrepareStepForRuntimeTarget({ kind: 'local' }, 'r1', APPROVAL)
    ).resolves.toEqual({ status: 'started' })
    expect(runPrepareStep).toHaveBeenCalledWith({ repoId: 'r1', ...APPROVAL })
    expect(Object.keys(runPrepareStep.mock.calls[0][0])).not.toContain('command')
  })

  it('asks the remote runtime with the strict parameter set', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'x',
      ok: true,
      result: { status: 'refused', reason: 'approval-missing' }
    })
    await expect(runPrepareStepForRuntimeTarget(remote, 'r1', APPROVAL)).resolves.toEqual({
      status: 'refused',
      reason: 'approval-missing'
    })
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'environment.runPrepareStep',
        params: { repo: 'id:r1', ...APPROVAL }
      })
    )
  })

  it('old runtime refuses prepare', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'x',
      ok: false,
      error: { code: 'method_not_found', message: 'Unknown method' }
    })
    await expect(runPrepareStepForRuntimeTarget(remote, 'r1', APPROVAL)).resolves.toEqual({
      status: 'refused',
      reason: 'host-predates-prepare'
    })
  })

  it('a failure after the request was sent is unknown, never "not started"', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'x',
      ok: false,
      error: { code: 'runtime_unavailable', message: 'down' }
    })
    await expect(runPrepareStepForRuntimeTarget(remote, 'r1', APPROVAL)).resolves.toEqual({
      status: 'unknown'
    })
    runtimeEnvironmentCall.mockRejectedValueOnce(new Error('Runtime call timed out'))
    await expect(runPrepareStepForRuntimeTarget(remote, 'r1', APPROVAL)).resolves.toEqual({
      status: 'unknown'
    })
    runPrepareStep.mockRejectedValueOnce(new Error('ipc'))
    await expect(
      runPrepareStepForRuntimeTarget({ kind: 'local' }, 'r1', APPROVAL)
    ).resolves.toEqual({ status: 'unknown' })
  })

  it('a failure provably before the request was sent is unreachable', async () => {
    vi.stubGlobal('window', {
      api: {
        environment: { measureRequirements, runPrepareStep },
        runtimeEnvironments: {
          call: (args: RuntimeEnvironmentCallRequest) => {
            if (args.method === 'status.get') {
              return Promise.reject(new Error('no route to host'))
            }
            return runtimeEnvironmentCall(args)
          }
        }
      }
    })
    await expect(runPrepareStepForRuntimeTarget(remote, 'r1', APPROVAL)).resolves.toEqual({
      status: 'refused',
      reason: 'unreachable'
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('a refusal reason this client does not know is described, not passed through', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'x',
      ok: true,
      result: { status: 'refused', reason: 'quota-exceeded' }
    })
    await expect(runPrepareStepForRuntimeTarget(remote, 'r1', APPROVAL)).resolves.toEqual({
      status: 'refused',
      reason: 'host-refused-unknown'
    })
  })

  it.each([
    { status: 'queued' },
    { status: 'refused' },
    { status: 'refused', reason: 7 },
    null,
    'started'
  ])('an answer shape this client does not understand is unknown: %j', async (answer) => {
    runtimeEnvironmentCall.mockResolvedValueOnce({ id: 'x', ok: true, result: answer })
    await expect(runPrepareStepForRuntimeTarget(remote, 'r1', APPROVAL)).resolves.toEqual({
      status: 'unknown'
    })
  })
})
