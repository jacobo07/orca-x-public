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

const TargetIdParams = z.object({ targetId: z.string().min(1).max(64) })

const GrantParams = z.object({
  deviceId: z.string().min(1).max(128),
  targetId: z.string().min(1).max(64)
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
  }),
  defineMethod({
    name: 'host.wake.admin.targetRemove',
    params: TargetIdParams,
    handler: async (params, ctx) => {
      if (!adminStore(ctx).removeTarget(params.targetId)) {
        throw hostWakeRefusal('wake_target_unknown', 'That wake target is not registered.')
      }
      return { removed: true, targetId: params.targetId }
    }
  }),
  defineMethod({
    name: 'host.wake.admin.grantAdd',
    params: GrantParams,
    handler: async (params, ctx) => {
      const store = adminStore(ctx)
      const authority = wakeBrokerHost.authority()
      if (!authority) {
        throw hostWakeRefusal(
          'wake_broker_unavailable',
          'The wake broker cannot judge devices yet.',
          { brokerState: 'device_authority_missing' }
        )
      }
      // Why at grant time too: an unknown or revoked device must not be planted ahead of the effect check (T-19-21).
      if (!authority.deviceExists(params.deviceId)) {
        throw hostWakeRefusal('wake_device_unknown', 'That device is not paired with this host.')
      }
      return { grant: store.addGrant(params.deviceId, params.targetId) }
    }
  }),
  defineMethod({
    name: 'host.wake.admin.grantRemove',
    params: GrantParams,
    handler: async (params, ctx) => ({
      removed: adminStore(ctx).removeGrant(params.deviceId, params.targetId)
    })
  }),
  defineMethod({
    name: 'host.wake.admin.grantList',
    params: null,
    handler: async (_params, ctx) => ({ grants: adminStore(ctx).grants() })
  })
]
