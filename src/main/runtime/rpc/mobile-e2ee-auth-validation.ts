import type { DesktopMobileE2EEV2Session } from './mobile-e2ee-v2-desktop-session'
import { publicKeyFromBase64 } from './e2ee-crypto'
import { parseRemoteRuntimeJsonText } from '../../../shared/remote-runtime-request-frames'

export type MobileE2EEAuth = {
  type: 'e2ee_auth'
  deviceToken: string
  clientCapabilities?: unknown
  v?: 2
  transcriptHashB64?: string
}

export function isValidMobileE2EEAuthVersion(
  auth: MobileE2EEAuth,
  v2Session: DesktopMobileE2EEV2Session | null
): boolean {
  if (!v2Session) {
    return auth.v === undefined && auth.transcriptHashB64 === undefined
  }
  // Why: mobile v2 keeps an exact transcript-bound shape; runtime capabilities use legacy paired-runtime auth.
  return (
    Object.keys(auth).sort().join(',') === 'deviceToken,transcriptHashB64,type,v' &&
    auth.v === 2 &&
    auth.transcriptHashB64 === v2Session.transcriptHashB64
  )
}

type MobileE2EEAuthFailureCode = 'bad_auth' | 'unauthorized'

export type MobileE2EEAuthFailure = {
  ok: false
  code: MobileE2EEAuthFailureCode
  /** The e2ee_error payload. `reason` is a new optional field: old phones read only `code` and keep retrying. */
  error: { code: MobileE2EEAuthFailureCode; reason?: 'device_revoked' }
}

function refuse(code: MobileE2EEAuthFailureCode, reason?: 'device_revoked'): MobileE2EEAuthFailure {
  return { ok: false, code, error: reason ? { code, reason } : { code } }
}

export function authenticateMobileE2EE<TDevice extends { deviceToken: string }>(args: {
  plaintext: string
  v2Session: DesktopMobileE2EEV2Session | null
  resolveDevice: (token: string) => TDevice | null
  isRevokedToken?: (token: string) => boolean
}): { ok: true; device: TDevice; auth: MobileE2EEAuth } | MobileE2EEAuthFailure {
  let auth: MobileE2EEAuth
  try {
    auth = parseRemoteRuntimeJsonText(args.plaintext) as MobileE2EEAuth
  } catch {
    return refuse('bad_auth')
  }
  if (
    auth.type !== 'e2ee_auth' ||
    !auth.deviceToken ||
    !isValidMobileE2EEAuthVersion(auth, args.v2Session)
  ) {
    return refuse('bad_auth')
  }
  const device = args.resolveDevice(auth.deviceToken)
  if (device?.deviceToken === auth.deviceToken) {
    return { ok: true, device, auth }
  }
  // Why: the holder of a revoked token learns nothing new by hearing so, and can stop retrying.
  return refuse(
    'unauthorized',
    args.isRevokedToken?.(auth.deviceToken) ? 'device_revoked' : undefined
  )
}

export function decodeMobileE2EEPublicKey(value: string): Uint8Array | null {
  try {
    return publicKeyFromBase64(value)
  } catch {
    return null
  }
}
