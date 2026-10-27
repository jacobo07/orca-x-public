import { isIPv4 } from 'node:net'
import { z } from 'zod'
import { defineMethod, type RpcContext, type RpcMethod } from '../core'
import { isLocalRpcCaller } from '../local-rpc-caller'
import {
  WAKE_DEFAULT_BROADCAST,
  WAKE_DEFAULT_PORT,
  hostWakeRefusal,
  isWakeTargetLabel,
  normalizeMac
} from '../../../../shared/host-wake'
import { wakeBrokerHost } from '../../wake-broker-host'
import type { WakeBrokerStore } from '../../wake-broker-store'
import type { WakeBrokerStoreView } from '../../wake-broker'

const TargetAddParams = z.object({
  mac: z.string().refine((mac) => normalizeMac(mac) !== null, {
    message: 'mac must be six hex octets separated by : or -'
  }),
  broadcast: z
    .string()
    .refine((address) => isIPv4(address), { message: 'broadcast must be an IPv4 address' })
    .optional(),
  port: z.number().int().min(1).max(65_535).optional(),
  label: z
    .string()
    .refine(isWakeTargetLabel, { message: 'label must be 1-64 printable characters' })
    .optional()
})

function remoteCallerRefused(): Error {
  return Object.assign(new Error('Wake administration is local-only on the broker host.'), {
    code: 'remote_caller_refused'
  })
}

function isPersistentStore(store: WakeBrokerStoreView): store is WakeBrokerStore {
  return typeof (store as Partial<WakeBrokerStore>).addTarget === 'function'
}

// Why local-only: targets and grants are the Owner's act on the broker (D-05, D-07); runtime-scope
// paired devices skip the mobile allowlist, so this check is the boundary.
function adminStore(ctx: RpcContext): WakeBrokerStore {
  if (!isLocalRpcCaller(ctx)) {
    throw remoteCallerRefused()
  }
  const enabled = wakeBrokerHost.current()
  if (enabled && isPersistentStore(enabled.store)) {
    return enabled.store
  }
  const reason = enabled ? 'wake_broker_store_read_only' : wakeBrokerHost.unavailableReason()
  if (reason) {
    throw hostWakeRefusal('wake_broker_unavailable', 'The wake broker could not start.', {
      brokerState: reason
    })
  }
  throw hostWakeRefusal(
    'wake_broker_disabled',
    'This host is not a wake broker. Start it with `orca serve --wake-broker`.'
  )
}

export const HOST_WAKE_ADMIN_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'host.wake.admin.targetAdd',
    params: TargetAddParams,
    handler: async (params, ctx) => {
      const store = adminStore(ctx)
      const target = store.addTarget({
        mac: params.mac,
        broadcast: params.broadcast ?? WAKE_DEFAULT_BROADCAST,
        port: params.port ?? WAKE_DEFAULT_PORT,
        label: params.label ?? ''
      })
      return { target }
    }
  }),
  defineMethod({
    name: 'host.wake.admin.targetList',
    params: null,
    handler: async (_params, ctx) => ({ targets: adminStore(ctx).targets() })
  })
]
