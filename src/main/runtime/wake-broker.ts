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

export const WAKE_DEDUPE_WINDOW_MS = 60_000
export const WAKE_ADOPT_WINDOW_MS = 10_000
export const WAKE_STATUS_RETENTION_MS = 300_000
export const WAKE_RECORD_CAP = 256
// Why one: "a duplicate request sends exactly one packet" must stay literally checkable (D-14).
export const WAKE_BURST_COUNT = 1

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

type WakeOutcome = { entry: WakeRecord; adopted: boolean }
type PendingWake<T> = { startedAt: number; done: Promise<T> }

const SEND_ERROR_CODE = /^[A-Za-z0-9_]{1,64}$/

export function mintWakeId(): string {
  return `wk_${randomBytes(8).toString('hex')}`
}

function sendErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && SEND_ERROR_CODE.test(code) ? code : 'send_failed'
}

function evictOldest<K, V>(map: Map<K, V>, cap: number): void {
  for (const key of map.keys()) {
    if (map.size <= cap) {
      return
    }
    map.delete(key)
  }
}

function dropExpired<K, V>(map: Map<K, V>, startedAt: (value: V) => number, cutoff: number): void {
  for (const [key, value] of map) {
    if (startedAt(value) < cutoff) {
      map.delete(key)
    }
  }
}

export function createWakeBroker(deps: WakeBrokerDeps): WakeBroker {
  const records = new Map<string, WakeRecord>()
  const replays = new Map<string, PendingWake<WakeOutcome>>()
  // Why keyed by target: two devices waking one host must contend, never send two bursts (D-09).
  const adoptable = new Map<string, PendingWake<WakeRecord>>()

  // Why lazy: windows are enforced against now() on each call, so the broker owns no timer (R4).
  function prune(): void {
    const now = deps.now()
    dropExpired(records, (r) => r.requestedAt, now - WAKE_STATUS_RETENTION_MS)
    dropExpired(replays, (p) => p.startedAt, now - WAKE_DEDUPE_WINDOW_MS)
    dropExpired(adoptable, (p) => p.startedAt, now - WAKE_ADOPT_WINDOW_MS)
  }

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

  function copyStages(entry: WakeRecord): HostWakeStageRecord[] {
    return entry.stages.map((stage) => ({ ...stage }))
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
          stages: copyStages(entry)
        })
      }
      throw error
    }
    try {
      const frame = buildMagicPacket(target.mac)
      for (let burst = 0; burst < WAKE_BURST_COUNT; burst++) {
        await deps.sendMagicPacket(frame, target.broadcast, target.port)
      }
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

  function start(caller: WakeCaller, target: WakeTarget): Promise<WakeOutcome> {
    const entry: WakeRecord = {
      wakeId: deps.newWakeId(),
      targetId: target.targetId,
      requestedAt: deps.now(),
      stages: []
    }
    records.set(entry.wakeId, entry)
    evictOldest(records, WAKE_RECORD_CAP)
    const done = sendWake(caller, target, entry).then(() => entry)
    const pending = { startedAt: entry.requestedAt, done }
    adoptable.set(target.targetId, pending)
    // Why: a failed wake is not adoptable; the next request for the target starts its own.
    done.catch(() => {
      if (adoptable.get(target.targetId) === pending) {
        adoptable.delete(target.targetId)
      }
    })
    return done.then((sent) => ({ entry: sent, adopted: false }))
  }

  function startOrAdopt(caller: WakeCaller, target: WakeTarget): Promise<WakeOutcome> {
    const inFlight = adoptable.get(target.targetId)
    if (!inFlight) {
      return start(caller, target)
    }
    return inFlight.done.then(
      (entry) => ({ entry, adopted: true }),
      () => startOrAdopt(caller, target)
    )
  }

  function outcomeResult(outcome: WakeOutcome): HostWakeRequestResult {
    return {
      wakeId: outcome.entry.wakeId,
      targetId: outcome.entry.targetId,
      replayed: false,
      adopted: outcome.adopted,
      stages: copyStages(outcome.entry)
    }
  }

  return {
    async request(args) {
      prune()
      // Why authority first: a revoked or ungranted device never receives a replay (T-19-07).
      const target = judge(args, args.targetId)
      const replayKey = `${target.targetId}\u0000${args.requestId}`
      const prior = replays.get(replayKey)
      if (prior) {
        const outcome = await prior.done
        return { ...outcomeResult(outcome), replayed: true }
      }
      const pending = { startedAt: deps.now(), done: startOrAdopt(args, target) }
      replays.set(replayKey, pending)
      evictOldest(replays, WAKE_RECORD_CAP)
      pending.done.catch(() => {
        if (replays.get(replayKey) === pending) {
          replays.delete(replayKey)
        }
      })
      return outcomeResult(await pending.done)
    },

    status(args) {
      prune()
      const deviceId = authorizeCaller(args)
      const entry = records.get(args.wakeId)
      if (!entry || !deps.store.hasGrant(deviceId, entry.targetId)) {
        throw hostWakeRefusal('wake_unknown', 'No wake with that id is visible to this device.')
      }
      return { wakeId: entry.wakeId, targetId: entry.targetId, stages: copyStages(entry) }
    },

    targetsFor(args) {
      prune()
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
