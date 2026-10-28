import type {
  EnvironmentRequirementsMeasurement,
  RequirementsMeasurementOutcome
} from '../../../shared/environment-requirements-measurement'
import {
  isPrepareHostRefusalReason,
  type PrepareStepRunOutcome,
  type RunPrepareStepRequest
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

// Read the host's answer as data: a runtime updates independently, so any shape may arrive.
function readPrepareHostAnswer(answer: unknown): PrepareStepRunOutcome {
  const record =
    typeof answer === 'object' && answer !== null ? (answer as Record<string, unknown>) : null
  if (record?.status === 'started') {
    return { status: 'started' }
  }
  if (record?.status === 'refused' && typeof record.reason === 'string') {
    return {
      status: 'refused',
      reason: isPrepareHostRefusalReason(record.reason) ? record.reason : 'host-refused-unknown'
    }
  }
  // Why: the host answered something this client cannot read, so it may have started the step.
  return { status: 'unknown' }
}

/**
 * Ask the host that owns the repo to run one approved prepare step. The request names a requirement
 * and an approval hash and never carries command text. Only a failure that provably precedes the
 * request (or an old runtime without the method) may say nothing started; once the request was sent,
 * a timeout or a dropped transport is `unknown`, because the host may still have spawned the step.
 * RUN_TIMEOUT_MS is shorter than the host's worst case (an SSH re-measure can take over a minute),
 * so a timeout here is expected to be `unknown`, not a failure to reach the host.
 */
export async function runPrepareStepForRuntimeTarget(
  runtimeTarget: RuntimeClientTarget,
  repoId: string,
  request: RunPrepareStepRequest
): Promise<PrepareStepRunOutcome> {
  let sent = false
  try {
    let answer: unknown
    if (runtimeTarget.kind === 'local') {
      sent = true
      answer = await window.api.environment.runPrepareStep({ repoId, ...request })
    } else {
      answer = await callRuntimeRpc<unknown>(
        runtimeTarget,
        'environment.runPrepareStep',
        { repo: `id:${repoId}`, ...request },
        {
          timeoutMs: RUN_TIMEOUT_MS,
          onRequestSent: () => {
            sent = true
          }
        }
      )
    }
    return readPrepareHostAnswer(answer)
  } catch (error) {
    if (hasRuntimeRpcErrorCode(error, 'method_not_found')) {
      return { status: 'refused', reason: 'host-predates-prepare' }
    }
    return sent ? { status: 'unknown' } : { status: 'refused', reason: 'unreachable' }
  }
}
