import type {
  FleetPlacementViewParams,
  FleetPlacementViewResult
} from '../../shared/fleet-placement-view'
import type { NodeManifestsResult } from '../../shared/node-manifest'
import type { CommandHandler } from '../dispatch'
import { getOptionalPositiveIntegerFlag, getOptionalStringFlag } from '../flags'
import { formatNodeManifests, nodeManifestsExitCode } from '../fleet-node-manifest-format'
import { fleetPlacementExitCode, formatFleetPlacementView } from '../fleet-placement-format'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime/types'

const MAX_MODEL_PROBE_PORTS = 4

export function fleetPlacementParams(
  flags: Map<string, string | boolean>
): FleetPlacementViewParams {
  const minMb = getOptionalPositiveIntegerFlag(flags, 'min-available-mb')
  const platform = getOptionalStringFlag(flags, 'platform')
  const capabilities = getOptionalStringFlag(flags, 'capabilities')
    ?.split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  const maxSampleAgeMs = getOptionalPositiveIntegerFlag(flags, 'max-sample-age-ms')
  return {
    ...(minMb !== undefined ? { minAvailableBytes: minMb * 1024 * 1024 } : {}),
    ...(platform ? { platform } : {}),
    ...(capabilities?.length ? { requiredCapabilities: capabilities } : {}),
    ...(maxSampleAgeMs !== undefined ? { maxSampleAgeMs } : {})
  }
}

export function fleetManifestParams(flags: Map<string, string | boolean>): {
  modelProbePorts?: number[]
} {
  const raw = getOptionalStringFlag(flags, 'model-probe-ports')
  if (raw === undefined) {
    return {}
  }
  const ports = raw.split(',').map((entry) => entry.trim())
  const valid = ports.every(
    (entry) => /^\d+$/.test(entry) && Number(entry) >= 1 && Number(entry) <= 65535
  )
  if (!valid || ports.length > MAX_MODEL_PROBE_PORTS) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Invalid --model-probe-ports: give at most ${MAX_MODEL_PROBE_PORTS} ports, each 1-65535`
    )
  }
  return { modelProbePorts: ports.map(Number) }
}

export const FLEET_HANDLERS: Record<string, CommandHandler> = {
  'fleet placement': async ({ client, flags, json }) => {
    const response = await client.call<FleetPlacementViewResult>(
      'fleet.placementView',
      fleetPlacementParams(flags)
    )
    process.exitCode = fleetPlacementExitCode(response.result)
    printResult(response, json, formatFleetPlacementView)
  },
  'fleet manifest': async ({ client, flags, json }) => {
    const response = await client.call<NodeManifestsResult>(
      'fleet.nodeManifests',
      fleetManifestParams(flags)
    )
    process.exitCode = nodeManifestsExitCode(response.result)
    printResult(response, json, formatNodeManifests)
  }
}
