import { z } from 'zod'
import { planFleetPlacement, type FleetPlacementRequest } from '../../../../shared/fleet-placement'
import type { FleetPlacementViewResult } from '../../../../shared/fleet-placement-view'
import { buildNodeManifests, type NodeManifestsResult } from '../../../../shared/node-manifest'
import { readFleetObservation } from '../../../fleet/fleet-observation-slot'
import type { NodeResourcesReply } from '../../../fleet/node-resources-measure'
import { readNodeResources } from '../../../fleet/node-resources-slot'
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

// Why: ports only (never a URL), so a paired peer cannot make this host fetch an arbitrary address.
const NodeResourcesParams = z
  .object({ modelProbePorts: z.array(z.number().int().min(1).max(65535)).max(4).optional() })
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
  }),
  defineMethod({
    name: 'fleet.nodeManifests',
    params: NodeResourcesParams.optional(),
    handler: async (params, ctx): Promise<NodeManifestsResult> => {
      // Why: answering would have this host query its own paired runtimes on another's behalf.
      if (!isLocalRpcCaller(ctx)) {
        return { status: 'refused', reason: 'remote-caller' }
      }
      const pending = readFleetObservation(
        params?.modelProbePorts ? { modelProbePorts: params.modelProbePorts } : undefined
      )
      if (!pending) {
        return { status: 'unavailable', reason: 'no-fleet-reader' }
      }
      const observation = await pending
      return {
        status: 'ok',
        observedAt: observation.completedAt,
        manifests: buildNodeManifests(observation)
      }
    }
  }),
  defineMethod({
    name: 'fleet.nodeResources',
    params: NodeResourcesParams.optional(),
    // Why: it reads only this host, so unlike the placement view it needs no remote-caller refusal.
    handler: async (params): Promise<NodeResourcesReply> => readNodeResources(params ?? {})
  })
]
