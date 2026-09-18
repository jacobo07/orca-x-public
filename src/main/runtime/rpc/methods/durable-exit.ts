import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ParkResult } from '../../../../shared/durable-exit-types'
import { getParkCoordinator } from '../../../durable-exit/park-coordinator'
import { defineMethod, type RpcContext, type RpcMethod } from '../core'

const ParkParams = z.object({
  mode: z.enum(['plan', 'park']),
  includePinned: z.boolean()
})

function unavailable(detail: string): ParkResult {
  return {
    operationId: randomUUID(),
    status: 'unavailable',
    workspaces: [],
    alreadyAsleepCount: 0,
    exiting: false,
    detail
  }
}

/** Only the local CLI may quit this desktop; paired devices and saved environments may not. */
export function isRemoteParkCaller(ctx: RpcContext): boolean {
  return Boolean(
    ctx.pairedDeviceId ||
    ctx.clientKind ||
    ctx.clientId ||
    ctx.connectionId ||
    ctx.authenticatedCallerFingerprint
  )
}

export const DURABLE_EXIT_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'app.park',
    params: ParkParams,
    handler: (params, ctx) => {
      if (isRemoteParkCaller(ctx)) {
        return unavailable('remote-caller')
      }
      // Why the same coordinator as the menu: one park authority, whoever asks.
      return getParkCoordinator()?.park(params) ?? unavailable('no-coordinator')
    }
  })
]
