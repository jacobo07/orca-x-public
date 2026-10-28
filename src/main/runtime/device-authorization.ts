import type { DeviceEntry, DeviceRegistry } from './device-registry'

export type DeviceRefusalReason = 'device_revoked' | 'unknown_token' | 'registry_unavailable'

export type DeviceAuthorization =
  | { ok: true; device: DeviceEntry }
  | { ok: false; reason: DeviceRefusalReason }

// Why: the wire code and close code old clients already treat as an auth failure; the reason must never replace them.
export const DEVICE_UNAUTHORIZED_CLOSE_CODE = 4001
export const DEVICE_UNAUTHORIZED_CLOSE_REASON = 'Unauthorized'

/**
 * The one effect-time judgement of a paired device, keyed by its token (the subject), never by the
 * socket or transport that carries it. Every transport asks here at the moment it would act.
 */
export function assertDeviceStillAuthorized(
  registry: DeviceRegistry,
  token: string
): DeviceAuthorization {
  if (!registry.getAvailability().available) {
    return { ok: false, reason: 'registry_unavailable' }
  }
  const device = registry.validateToken(token)
  if (device) {
    return { ok: true, device }
  }
  return { ok: false, reason: registry.isRevokedToken(token) ? 'device_revoked' : 'unknown_token' }
}

// Why: only the revoked reason is new information for a client; the rest keep today's plain auth failure.
export function deviceRefusalDetail(reason: DeviceRefusalReason): {
  message: string
  data?: { reason: DeviceRefusalReason }
} {
  return reason === 'device_revoked'
    ? { message: 'Device access revoked', data: { reason } }
    : { message: 'Invalid device token' }
}

/**
 * Removes a device and ends its live connections. The registry revokes in memory before it saves, so a
 * save failure still leaves the device refused; its sockets must go either way, then the error propagates.
 */
export function revokeDeviceAndTerminateConnections(
  registry: DeviceRegistry,
  device: DeviceEntry,
  terminateConnections: (deviceToken: string) => void
): boolean {
  try {
    return registry.removeDevice(device.deviceId)
  } finally {
    // Why: sockets are keyed by the raw token, which is known only once the device authenticated this run;
    // a device that never did has no sockets (D2 keeps only its digest at rest).
    if (registry.getDevice(device.deviceId) === null && device.token !== undefined) {
      terminateConnections(device.token)
    }
  }
}
