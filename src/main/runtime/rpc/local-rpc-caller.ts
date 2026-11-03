import type { RpcContext } from './core'

/**
 * The local CLI socket dispatches with no caller context; every remote transport stamps at
 * least one of these. Any stamp means the request did not originate on this machine, except
 * this runtime's own mutation fingerprint, which the dispatcher stamps on local mutations.
 */
export function isLocalRpcCaller(ctx: RpcContext): boolean {
  return !(
    ctx.pairedDeviceId ||
    ctx.clientKind ||
    ctx.clientId ||
    ctx.connectionId ||
    (ctx.authenticatedCallerFingerprint && !isLocalMutationFingerprint(ctx))
  )
}

// Why: the dispatcher stamps this runtime's own fingerprint on every local mutation.
function isLocalMutationFingerprint(ctx: RpcContext): boolean {
  try {
    const local = ctx.runtime.getOrchestrationDb().getOrCreateLocalMutationCallerFingerprint()
    return ctx.authenticatedCallerFingerprint === local
  } catch {
    return false
  }
}

// Why the same stamps as isLocalRpcCaller: any of them means the request came from another machine.
export function isLocalStreamingCaller(options?: {
  pairedDeviceId?: unknown
  clientId?: unknown
  connectionId?: unknown
  clientKind?: unknown
  authenticatedCallerFingerprint?: unknown
}): boolean {
  return !(
    options?.pairedDeviceId ||
    options?.clientId ||
    options?.connectionId ||
    options?.clientKind ||
    options?.authenticatedCallerFingerprint
  )
}
