import { randomBytes } from 'node:crypto'
import {
  hostWakeRefusal,
  HostWakeRefusal,
  type HostWakeRequestResult,
  type HostWakeStageRecord,
  type HostWakeStatusResult,
  type HostWakeTargetSummary
} from '../../shared/host-wake'
import { buildMagicPacket } from './wake-magic-packet'

export type WakeTarget = {
  targetId: string
  mac: string
  broadcast: string
  port: number
  label: string
  createdAt: number
}

export type WakeBrokerStoreView = {
  targets(): WakeTarget[]
  target(targetId: string): WakeTarget | null
  hasGrant(deviceId: string, targetId: string): boolean
}

export type WakeDeviceAuthorization = { ok: true; deviceId: string } | { ok: false; reason: string }

export type WakeDeviceAuthority = {
  authorize(token: string): WakeDeviceAuthorization
  deviceExists(deviceId: string): boolean
}

export type WakeBrokerDeps = {
  now: () => number
  store: WakeBrokerStoreView
  authority: () => WakeDeviceAuthority | null
  sendMagicPacket: (frame: Buffer, address: string, port: number) => Promise<void>
  newWakeId: () => string
}

export type WakeCaller = { token: string | undefined; deviceId: string | undefined }

export type WakeBroker = {
  request(
    args: WakeCaller & { targetId: string; requestId: string }
  ): Promise<HostWakeRequestResult>
  status(args: WakeCaller & { wakeId: string }): HostWakeStatusResult
  targetsFor(args: WakeCaller): { targets: HostWakeTargetSummary[] }
}

type WakeRecord = {
  wakeId: string
  targetId: string
  requestedAt: number
  stages: HostWakeStageRecord[]
}

const SEND_ERROR_CODE = /^[A-Za-z0-9_]{1,64}$/

export function mintWakeId(): string {
  return `wk_${randomBytes(8).toString('hex')}`
}

function sendErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && SEND_ERROR_CODE.test(code) ? code : 'send_failed'
}

export function createWakeBroker(deps: WakeBrokerDeps): WakeBroker {
  const records = new Map<string, WakeRecord>()

  function authorizeCaller(caller: WakeCaller): string {
    const authority = deps.authority()
    if (!authority) {
      throw hostWakeRefusal('wake_broker_unavailable', 'The wake broker has no device authority.')
    }
    if (!caller.token || !caller.deviceId) {
      throw hostWakeRefusal('wake_device_required', 'Wake requests must come from a paired device.')
    }
    const verdict = authority.authorize(caller.token)
    if (!verdict.ok) {
      throw verdict.reason === 'device_revoked'
        ? hostWakeRefusal('wake_device_revoked', 'This device was revoked on the wake broker.')
        : hostWakeRefusal('wake_device_unauthorized', 'This device is not authorized to wake.')
    }
    if (verdict.deviceId !== caller.deviceId) {
      throw hostWakeRefusal('wake_device_unauthorized', 'This device is not authorized to wake.')
    }
    return verdict.deviceId
  }

  // Why grant before target: an ungranted device cannot learn which target ids exist (T-19-09).
  function judge(caller: WakeCaller, targetId: string): WakeTarget {
    const deviceId = authorizeCaller(caller)
    if (!deps.store.hasGrant(deviceId, targetId)) {
      throw hostWakeRefusal(
        'wake_grant_missing',
        'This device holds no wake grant for that target.'
      )
    }
    const target = deps.store.target(targetId)
    if (!target) {
      throw hostWakeRefusal('wake_target_unknown', 'That wake target is no longer registered.')
    }
    return target
  }

  function record(entry: WakeRecord, stage: HostWakeStageRecord['stage'], code?: string): void {
    entry.stages.push({
      stage,
      observedAt: deps.now(),
      observer: 'broker',
      ...(code ? { code } : {})
    })
  }

  function snapshot(entry: WakeRecord, replayed: boolean, adopted: boolean): HostWakeRequestResult {
    return {
      wakeId: entry.wakeId,
      targetId: entry.targetId,
      replayed,
      adopted,
      stages: entry.stages.map((stage) => ({ ...stage }))
    }
  }

  async function sendWake(
    caller: WakeCaller,
    target: WakeTarget,
    entry: WakeRecord
  ): Promise<void> {
    record(entry, 'requested')
    record(entry, 'authorized')
    try {
      // Why: the effect moment re-judges, so a device revoked since the first check sends nothing (D-08).
      judge(caller, target.targetId)
    } catch (error) {
      if (error instanceof HostWakeRefusal) {
        throw hostWakeRefusal(error.code, error.message, {
          wakeId: entry.wakeId,
          stages: entry.stages.map((stage) => ({ ...stage }))
        })
      }
      throw error
    }
    try {
      await deps.sendMagicPacket(buildMagicPacket(target.mac), target.broadcast, target.port)
    } catch (error) {
      const code = sendErrorCode(error)
      record(entry, 'packet-send-failed', code)
      throw hostWakeRefusal('wake_send_failed', 'The wake packet could not be sent.', {
        wakeId: entry.wakeId,
        code
      })
    }
    record(entry, 'packet-sent')
  }

  return {
    async request(args) {
      const target = judge(args, args.targetId)
      const entry: WakeRecord = {
        wakeId: deps.newWakeId(),
        targetId: target.targetId,
        requestedAt: deps.now(),
        stages: []
      }
      records.set(entry.wakeId, entry)
      await sendWake(args, target, entry)
      return snapshot(entry, false, false)
    },

    status(args) {
      const deviceId = authorizeCaller(args)
      const entry = records.get(args.wakeId)
      if (!entry || !deps.store.hasGrant(deviceId, entry.targetId)) {
        throw hostWakeRefusal('wake_unknown', 'No wake with that id is visible to this device.')
      }
      return {
        wakeId: entry.wakeId,
        targetId: entry.targetId,
        stages: entry.stages.map((stage) => ({ ...stage }))
      }
    },

    targetsFor(args) {
      const deviceId = authorizeCaller(args)
      return {
        targets: deps.store
          .targets()
          .filter((target) => deps.store.hasGrant(deviceId, target.targetId))
          .map((target) => ({ targetId: target.targetId, label: target.label }))
      }
    }
  }
}
