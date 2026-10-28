// Why: one definition for the relay that answers and the host that asks; a renamed side would
// otherwise turn every SSH placement member into `unsupported` without any test noticing.
export const FLEET_RESOURCES_RELAY_METHOD = 'fleet.resources'
export const FLEET_RESOURCES_RELAY_CAPABILITY = 'fleet.resources.v1'
export const FLEET_RESOURCES_RELAY_CAPABILITIES = [FLEET_RESOURCES_RELAY_CAPABILITY] as const

/** Namespaced so an SSH host key can never collide with an Orca runtime key fingerprint. */
export function sshHostKeyPlacementFingerprint(fingerprint: string): string {
  return `ssh-hostkey:${fingerprint}`
}
