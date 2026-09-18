import { z } from 'zod'
import { planFleetPlacement, type FleetPlacementRequest } from '../../../../shared/fleet-placement'
import type { FleetPlacementViewResult } from '../../../../shared/fleet-placement-view'
import { readFleetObservation } from '../../../fleet/fleet-observation-slot'
import { defineMethod, type RpcMethod } from '../core'
import { isLocalRpcCaller } from '../local-rpc-caller'

export const DEFAULT_FLEET_SAMPLE_MAX_AGE_MS = 60_000

const PlacementViewParams = z
  .object({
    minAvailableBytes: z.number().finite().nonnegative().optional(),
    platform: z.string().min(1).optional(),
    requiredCapabilities: z.array(z.string().min(1)).optional(),
    currentFingerprint: z.string().min(1).optional(),
    maxSampleAgeMs: z.number().finite().positive().optional()
  })
  .strict()

export type { FleetPlacementViewResult }

export const FLEET_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'fleet.placementView',
    params: PlacementViewParams.optional(),
    handler: async (params, ctx): Promise<FleetPlacementViewResult> => {
      // Why: answering would have this host query its own paired runtimes on another's behalf.
      if (!isLocalRpcCaller(ctx)) {
        return { status: 'refused', reason: 'remote-caller' }
      }
      const pending = readFleetObservation()
      if (!pending) {
        return { status: 'unavailable', reason: 'no-fleet-reader' }
      }
      const observation = await pending
      const request: FleetPlacementRequest = {
        now: observation.completedAt,
        maxSampleAgeMs: params?.maxSampleAgeMs ?? DEFAULT_FLEET_SAMPLE_MAX_AGE_MS,
        ...(params?.minAvailableBytes !== undefined
          ? { minAvailableBytes: params.minAvailableBytes }
          : {}),
        ...(params?.platform ? { platform: params.platform as NodeJS.Platform } : {}),
        ...(params?.requiredCapabilities
          ? { requiredCapabilities: params.requiredCapabilities }
          : {}),
        ...(params?.currentFingerprint ? { currentFingerprint: params.currentFingerprint } : {})
      }
      return {
        status: 'ok',
        request,
        observation,
        proposal: planFleetPlacement(observation.members, request)
      }
    }
  })
]
