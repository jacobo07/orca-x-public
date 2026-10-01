import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'

const EnvironmentMeasureRequirementsParams = z.object({
  repo: z.string().trim().min(1, 'Missing repo selector')
})

// Why: no command field exists and unknown keys are refused, so a caller cannot name what runs;
// the host spawns only the text it re-reads from orca.yaml.
const EnvironmentRunPrepareStepParams = z
  .object({
    repo: z.string().trim().min(1, 'Missing repo selector'),
    requirementId: z.string().min(1).max(64),
    approvedContentHash: z.string().regex(/^[0-9a-f]{64}$/, 'Expected a lowercase sha256'),
    approvedHostKey: z.string().min(1).max(512)
  })
  .strict()

// Why: measuring only reads the contract and probes the host; it launches nothing, so no `effect`.
export const ENVIRONMENT_REQUIREMENTS_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'environment.measureRequirements',
    params: EnvironmentMeasureRequirementsParams,
    handler: (params, { runtime }) => runtime.measureEnvironmentRequirements(params.repo)
  }),
  defineMethod({
    name: 'environment.runPrepareStep',
    params: EnvironmentRunPrepareStepParams,
    effect: 'launch',
    handler: (params, { runtime }) =>
      runtime.runEnvironmentPrepareStep({
        repoSelector: params.repo,
        requirementId: params.requirementId,
        approvedContentHash: params.approvedContentHash,
        approvedHostKey: params.approvedHostKey,
        origin: 'runtime-rpc'
      })
  })
]
