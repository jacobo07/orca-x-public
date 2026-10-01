import type {
  EnvironmentRequirementsMeasurement,
  RequirementsMeasurementOutcome
} from '../../../shared/environment-requirements-measurement'
import type {
  PrepareRefusalReasonCode,
  PrepareStepRunOutcome,
  RunPrepareStepRequest
} from '../../../shared/environment-prepare-run-result'
import {
  callRuntimeRpc,
  hasRuntimeRpcErrorCode,
  type RuntimeClientTarget
} from './runtime-rpc-client'

const MEASURE_TIMEOUT_MS = 90_000
const RUN_TIMEOUT_MS = 60_000

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

type PrepareHostAnswer =
  | { status: 'started' }
  | { status: 'refused'; reason: PrepareRefusalReasonCode }

/**
 * Ask the host that owns the repo to run one approved prepare step. The request names a requirement
 * and an approval hash and never carries command text. An old runtime and an unreachable host are
 * refusals by name: nothing here can report a step as started that the host did not start.
 */
export async function runPrepareStepForRuntimeTarget(
  runtimeTarget: RuntimeClientTarget,
  repoId: string,
  request: RunPrepareStepRequest
): Promise<PrepareStepRunOutcome> {
  try {
    const answer =
      runtimeTarget.kind === 'local'
        ? await window.api.environment.runPrepareStep({ repoId, ...request })
        : await callRuntimeRpc<PrepareHostAnswer>(
            runtimeTarget,
            'environment.runPrepareStep',
            { repo: `id:${repoId}`, ...request },
            { timeoutMs: RUN_TIMEOUT_MS }
          )
    return answer.status === 'started'
      ? { status: 'started' }
      : { status: 'refused', reason: answer.reason }
  } catch (error) {
    if (hasRuntimeRpcErrorCode(error, 'method_not_found')) {
      return { status: 'refused', reason: 'host-predates-prepare' }
    }
    return { status: 'refused', reason: 'unreachable' }
  }
}
