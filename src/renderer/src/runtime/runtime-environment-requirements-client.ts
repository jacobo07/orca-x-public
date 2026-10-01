import type {
  EnvironmentRequirementsMeasurement,
  RequirementsMeasurementOutcome
} from '../../../shared/environment-requirements-measurement'
import {
  callRuntimeRpc,
  hasRuntimeRpcErrorCode,
  type RuntimeClientTarget
} from './runtime-rpc-client'

const MEASURE_TIMEOUT_MS = 90_000

/**
 * Measure a repo's orca.yaml requirements on the host that owns it: the local desktop host, or a
 * connected remote runtime. A runtime that predates the method is a named answer, not an empty
 * measurement; every other failure is rethrown so it is never read as "nothing required".
 */
export async function measureRequirementsForRuntimeTarget(
  runtimeTarget: RuntimeClientTarget,
  repoId: string
): Promise<RequirementsMeasurementOutcome> {
  try {
    const result =
      runtimeTarget.kind === 'local'
        ? await window.api.environment.measureRequirements({ repoId })
        : await callRuntimeRpc<EnvironmentRequirementsMeasurement>(
            runtimeTarget,
            'environment.measureRequirements',
            { repo: `id:${repoId}` },
            { timeoutMs: MEASURE_TIMEOUT_MS }
          )
    return { status: 'measured', result }
  } catch (error) {
    if (hasRuntimeRpcErrorCode(error, 'method_not_found')) {
      return { status: 'host-predates-probes', detail: 'method-not-found' }
    }
    throw error
  }
}
