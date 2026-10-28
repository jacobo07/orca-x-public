import { z } from 'zod'
import { defineMethod, type RpcContext, type RpcMethod } from '../core'
import { HOST_KEY_FORM, hostWakeRefusal } from '../../../../shared/host-wake'
import { wakeBrokerHost } from '../../wake-broker-host'
import type { WakeBroker, WakeCaller } from '../../wake-broker'

const WakeRequestParams = z.object({
  targetId: z.string().min(1).max(64),
  requestId: z.string().min(8).max(128),
  // Why optional: additive; an old broker strips it (z.object drops unknown keys) and wakes as before (WR-03).
  hostKey: z.string().regex(HOST_KEY_FORM).optional()
})

const WakeStatusParams = z.object({
  wakeId: z.string().min(1).max(64)
})

function enabledBroker(): WakeBroker {
  const enabled = wakeBrokerHost.current()
  if (enabled) {
    return enabled.broker
  }
  const reason = wakeBrokerHost.unavailableReason()
  if (reason) {
    throw hostWakeRefusal('wake_broker_unavailable', 'The wake broker could not start.', {
      brokerState: reason
    })
  }
  throw hostWakeRefusal('wake_broker_disabled', 'This host is not a wake broker.')
}

function wakeCaller(ctx: RpcContext): WakeCaller {
  return { token: ctx.clientId, deviceId: ctx.pairedDeviceId }
}

// Why no launch effect: a wake is not an Execution, and nothing here observes the socket signal, so a disconnect cannot cancel a send.
export const HOST_WAKE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'host.wake.targets',
    params: null,
    handler: async (_params, ctx) => enabledBroker().targetsFor(wakeCaller(ctx))
  }),
  defineMethod({
    name: 'host.wake.request',
    params: WakeRequestParams,
    handler: async (params, ctx) =>
      enabledBroker().request({
        ...wakeCaller(ctx),
        targetId: params.targetId,
        requestId: params.requestId,
        ...(params.hostKey !== undefined ? { hostKey: params.hostKey } : {})
      })
  }),
  defineMethod({
    name: 'host.wake.status',
    params: WakeStatusParams,
    handler: async (params, ctx) =>
      enabledBroker().status({ ...wakeCaller(ctx), wakeId: params.wakeId })
  })
]
