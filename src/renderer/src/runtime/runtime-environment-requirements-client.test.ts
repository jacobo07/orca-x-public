import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnvironmentRequirementsMeasurement } from '../../../shared/environment-requirements-measurement'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from './runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'
import { measureRequirementsForRuntimeTarget } from './runtime-environment-requirements-client'

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
const runtimeEnvironmentCall = vi.fn()
const remote = { kind: 'environment', environmentId: 'env-1' } as const

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  measureRequirements.mockReset()
  runtimeEnvironmentCall.mockReset()
  vi.stubGlobal('window', {
    api: {
      environment: { measureRequirements },
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
