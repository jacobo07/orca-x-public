import {
  observeFleet,
  type FleetObservation,
  type FleetObservationDeps,
  type FleetObservationOptions
} from './fleet-observation-service'

let installed: FleetObservationDeps | null = null

// Why a slot: the runtime service is built in both the window and `orca serve` paths, and the
// fleet reader needs main-only inputs (user data paths, the environment transport).
export function installFleetObservation(deps: FleetObservationDeps | null): void {
  installed = deps
}

export function readFleetObservation(
  options?: FleetObservationOptions
): Promise<FleetObservation> | null {
  return installed ? observeFleet(installed, options) : null
}
