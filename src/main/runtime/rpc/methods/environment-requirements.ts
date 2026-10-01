import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'

const EnvironmentMeasureRequirementsParams = z.object({
  repo: z.string().trim().min(1, 'Missing repo selector')
})

// Why: measuring only reads the contract and probes the host; it launches nothing, so no `effect`.
export const ENVIRONMENT_REQUIREMENTS_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'environment.measureRequirements',
    params: EnvironmentMeasureRequirementsParams,
    handler: (params, { runtime }) => runtime.measureEnvironmentRequirements(params.repo)
  })
]
