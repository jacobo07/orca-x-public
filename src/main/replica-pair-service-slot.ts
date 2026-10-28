import type { ReplicaPairService } from './replica-pair-service'

let installed: ReplicaPairService | null = null

// Why a slot: the SSH relay session exists only in the desktop process, so `orca serve` leaves it empty on purpose.
export function installReplicaPairService(service: ReplicaPairService | null): void {
  installed = service
}

export function readReplicaPairService(): ReplicaPairService | null {
  return installed
}
