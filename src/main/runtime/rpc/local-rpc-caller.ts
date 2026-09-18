import type { RpcContext } from './core'

/**
 * The local CLI socket dispatches with no caller context; every remote transport stamps at
 * least one of these. Any stamp means the request did not originate on this machine.
 */
export function isLocalRpcCaller(ctx: RpcContext): boolean {
  return !(
    ctx.pairedDeviceId ||
    ctx.clientKind ||
    ctx.clientId ||
    ctx.connectionId ||
    ctx.authenticatedCallerFingerprint
  )
}
