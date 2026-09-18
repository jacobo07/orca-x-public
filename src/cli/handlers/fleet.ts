import type {
  FleetPlacementViewParams,
  FleetPlacementViewResult
} from '../../shared/fleet-placement-view'
import type { CommandHandler } from '../dispatch'
import { getOptionalPositiveIntegerFlag, getOptionalStringFlag } from '../flags'
import { fleetPlacementExitCode, formatFleetPlacementView } from '../fleet-placement-format'
import { printResult } from '../format'

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

export const FLEET_HANDLERS: Record<string, CommandHandler> = {
  'fleet placement': async ({ client, flags, json }) => {
    const response = await client.call<FleetPlacementViewResult>(
      'fleet.placementView',
      fleetPlacementParams(flags)
    )
    process.exitCode = fleetPlacementExitCode(response.result)
    printResult(response, json, formatFleetPlacementView)
  }
}
