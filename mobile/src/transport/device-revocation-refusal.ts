export const DEVICE_REVOKED_MESSAGE = 'Device access revoked'

// Why: the desktop names this reason only for a token it revoked; an unnamed unauthorized may still be transient (#5200).
export function namesDeviceRevocation(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }
  const { reason, data } = error as { reason?: unknown; data?: { reason?: unknown } | null }
  return reason === 'device_revoked' || data?.reason === 'device_revoked'
}
