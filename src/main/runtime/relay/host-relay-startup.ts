import type { getOrcaCloudAuthConfig } from '../../orca-profiles/profile-cloud-auth-config'
import type { OrcaRuntimeRpcServer } from '../runtime-rpc'
import type { MobileRelayStatus } from '../../../shared/mobile-relay-status'
import { DesktopRelayService, type DesktopRelayServiceOptions } from './desktop-relay-service'

export type HostRelayUnavailableReason =
  | 'cloud_auth_not_configured'
  | 'mobile_runtime_not_ready'
  | 'relay_startup_failed'

export type HostRelayReadiness =
  | { state: 'started'; status: MobileRelayStatus | null }
  | { state: 'unavailable'; reason: HostRelayUnavailableReason }

export type HostRelayStartDeps = {
  cloudAuth: ReturnType<typeof getOrcaCloudAuthConfig>
  userDataPath: string
  appVersion: string
  runtimeRpc: OrcaRuntimeRpcServer
  onStatus: (status: MobileRelayStatus) => void
  onResume: (listener: () => void) => void
  warn?: (message: string, detail: string) => void
  createService?: (options: DesktopRelayServiceOptions) => DesktopRelayService
}

export type HostRelayStartResult = {
  service: DesktopRelayService | null
  getReadiness: () => HostRelayReadiness
}

export type HostRelayOwner = {
  start: (deps: HostRelayStartDeps) => HostRelayStartResult
}

function unavailable(reason: HostRelayUnavailableReason): HostRelayStartResult {
  const readiness: HostRelayReadiness = { state: 'unavailable', reason }
  return { service: null, getReadiness: () => readiness }
}

function startHostRelay(deps: HostRelayStartDeps): HostRelayStartResult {
  if (!deps.cloudAuth.configured) {
    return unavailable('cloud_auth_not_configured')
  }
  const cloudAuth = deps.cloudAuth
  // Why null until a callback: only the broker's own emission is an observation of relay state.
  let lastStatus: MobileRelayStatus | null = null
  try {
    const createService = deps.createService ?? ((options) => new DesktopRelayService(options))
    const relayService = createService({
      authConfig: cloudAuth.config,
      userDataPath: deps.userDataPath,
      appVersion: deps.appVersion,
      runtimeRpc: deps.runtimeRpc,
      onStatus: (status) => {
        lastStatus = status
        deps.onStatus(status)
      }
    })
    deps.runtimeRpc.setMobileRelayPairingProvider({
      createPairingRelay: (relayDeviceId) => relayService.createPairingRelay(relayDeviceId),
      onDeviceRevokeQueued: (item) => relayService.onDeviceRevokeQueued(item),
      onDemandStateChanged: () => relayService.demandStateChanged(),
      getEndpoints: (context, params) => relayService.getEndpoints(context, params),
      provisionRelay: (context, params) => relayService.provisionRelay(context, params)
    })
    relayService.start()
    // Why: sleeping past relay-token expiry kills the broker with no retry
    // timer; resume is the moment that state becomes recoverable.
    deps.onResume(() => relayService.ensureLive())
    return {
      service: relayService,
      getReadiness: () => ({ state: 'started', status: lastStatus })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ;(deps.warn ?? console.warn)('[relay] Host relay startup unavailable:', message)
    return unavailable(
      message === 'mobile_runtime_not_ready' ? 'mobile_runtime_not_ready' : 'relay_startup_failed'
    )
  }
}

export function createHostRelayOwner(): HostRelayOwner {
  let first: HostRelayStartResult | null = null
  return {
    // Why memoized: a second start in one process would open a second broker for the same host identity.
    start: (deps) => {
      first ??= startHostRelay(deps)
      return first
    }
  }
}
