import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { isIPv4 } from 'node:net'
import { join } from 'node:path'
import { hardenExistingSecureFile, writeDurableSecureJsonFile } from '../../shared/secure-file'
import { hostWakeRefusal } from '../../shared/host-wake'
import { normalizeMac } from './wake-magic-packet'
import type { WakeBrokerStoreView, WakeTarget } from './wake-broker'

export const WAKE_BROKER_STATE_FILENAME = 'orca-wake-broker.json'

const STATE_SCHEMA = 1
const TARGET_ID_FORM = /^wt_[0-9a-f]{12}$/
const LABEL_MAX = 64
const ID_MAX = 128

export type WakeGrant = { deviceId: string; targetId: string; grantedAt: number }

export type WakeTargetInput = { mac: string; broadcast: string; port: number; label: string }

export type WakeBrokerStore = WakeBrokerStoreView & {
  grants(): WakeGrant[]
  addTarget(input: WakeTargetInput): WakeTarget
  removeTarget(targetId: string): boolean
  addGrant(deviceId: string, targetId: string): WakeGrant
  removeGrant(deviceId: string, targetId: string): boolean
  dropGrantsForDevice(deviceId: string): number
  pruneGrants(keepDevice: (deviceId: string) => boolean): number
}

export type WakeBrokerStoreLoad =
  | { ok: true; store: WakeBrokerStore }
  | { ok: false; reason: 'wake_broker_state_unreadable' | 'wake_broker_state_io_failed' }

export type WakeBrokerStoreDeps = {
  publish?: (targetPath: string, value: unknown) => void
  now?: () => number
}

type WakeBrokerState = { schema: typeof STATE_SCHEMA; targets: WakeTarget[]; grants: WakeGrant[] }

function invalidArgument(message: string): Error {
  return Object.assign(new Error(message), { code: 'invalid_argument' })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65_535
}

function isStoredTarget(value: unknown): value is WakeTarget {
  return (
    isRecord(value) &&
    typeof value.targetId === 'string' &&
    TARGET_ID_FORM.test(value.targetId) &&
    typeof value.mac === 'string' &&
    normalizeMac(value.mac) === value.mac &&
    typeof value.broadcast === 'string' &&
    isIPv4(value.broadcast) &&
    isPort(value.port) &&
    typeof value.label === 'string' &&
    value.label.length <= LABEL_MAX &&
    typeof value.createdAt === 'number' &&
    Number.isFinite(value.createdAt)
  )
}

function isStoredGrant(value: unknown): value is WakeGrant {
  return (
    isRecord(value) &&
    typeof value.deviceId === 'string' &&
    value.deviceId.length > 0 &&
    value.deviceId.length <= ID_MAX &&
    typeof value.targetId === 'string' &&
    TARGET_ID_FORM.test(value.targetId) &&
    typeof value.grantedAt === 'number' &&
    Number.isFinite(value.grantedAt)
  )
}

function parseState(raw: string): WakeBrokerState | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(value) || value.schema !== STATE_SCHEMA) {
    return null
  }
  const { targets, grants } = value
  if (!Array.isArray(targets) || !targets.every(isStoredTarget)) {
    return null
  }
  if (!Array.isArray(grants) || !grants.every(isStoredGrant)) {
    return null
  }
  return { schema: STATE_SCHEMA, targets, grants }
}

function mintTargetId(taken: readonly WakeTarget[]): string {
  for (;;) {
    // Why random: an id must reveal nothing about the MAC it names (T-19-09).
    const candidate = `wt_${randomBytes(6).toString('hex')}`
    if (!taken.some((target) => target.targetId === candidate)) {
      return candidate
    }
  }
}

function createStore(
  statePath: string,
  initial: WakeBrokerState,
  publish: (targetPath: string, value: unknown) => void,
  now: () => number
): WakeBrokerStore {
  let state = initial

  // Why disk first: an addition is not valid until it is durable.
  function commitAddition(next: WakeBrokerState): void {
    publish(statePath, next)
    state = next
  }

  // Why memory first: a failed write can never leave a removed grant valid; the error still propagates.
  function commitRemoval(next: WakeBrokerState): void {
    state = next
    publish(statePath, next)
  }

  function keepGrants(keep: (grant: WakeGrant) => boolean): number {
    const grants = state.grants.filter(keep)
    const removed = state.grants.length - grants.length
    if (removed > 0) {
      commitRemoval({ ...state, grants })
    }
    return removed
  }

  return {
    targets: () => state.targets.map((target) => ({ ...target })),
    target: (targetId) => {
      const found = state.targets.find((target) => target.targetId === targetId)
      return found ? { ...found } : null
    },
    hasGrant: (deviceId, targetId) =>
      state.grants.some((grant) => grant.deviceId === deviceId && grant.targetId === targetId),
    grants: () => state.grants.map((grant) => ({ ...grant })),

    addTarget(input) {
      const mac = normalizeMac(input.mac)
      if (!mac) {
        throw invalidArgument('mac must be six hex octets separated by : or -')
      }
      if (!isIPv4(input.broadcast)) {
        throw invalidArgument('broadcast must be an IPv4 address')
      }
      if (!isPort(input.port)) {
        throw invalidArgument('port must be an integer from 1 to 65535')
      }
      const label = input.label.trim()
      if (label.length > LABEL_MAX) {
        throw invalidArgument(`label must be at most ${LABEL_MAX} characters`)
      }
      const target: WakeTarget = {
        targetId: mintTargetId(state.targets),
        mac,
        broadcast: input.broadcast,
        port: input.port,
        label,
        createdAt: now()
      }
      commitAddition({ ...state, targets: [...state.targets, target] })
      return { ...target }
    },

    removeTarget(targetId) {
      if (!state.targets.some((target) => target.targetId === targetId)) {
        return false
      }
      commitRemoval({
        ...state,
        targets: state.targets.filter((target) => target.targetId !== targetId),
        grants: state.grants.filter((grant) => grant.targetId !== targetId)
      })
      return true
    },

    addGrant(deviceId, targetId) {
      if (deviceId.length === 0 || deviceId.length > ID_MAX) {
        throw invalidArgument('deviceId is required')
      }
      if (!state.targets.some((target) => target.targetId === targetId)) {
        throw hostWakeRefusal('wake_target_unknown', 'That wake target is not registered.')
      }
      const existing = state.grants.find(
        (grant) => grant.deviceId === deviceId && grant.targetId === targetId
      )
      if (existing) {
        return { ...existing }
      }
      const grant: WakeGrant = { deviceId, targetId, grantedAt: now() }
      commitAddition({ ...state, grants: [...state.grants, grant] })
      return { ...grant }
    },

    removeGrant: (deviceId, targetId) =>
      keepGrants((grant) => grant.deviceId !== deviceId || grant.targetId !== targetId) > 0,
    dropGrantsForDevice: (deviceId) => keepGrants((grant) => grant.deviceId !== deviceId),
    pruneGrants: (keepDevice) => keepGrants((grant) => keepDevice(grant.deviceId))
  }
}

export function loadWakeBrokerStore(
  userDataPath: string,
  deps: WakeBrokerStoreDeps = {}
): WakeBrokerStoreLoad {
  const statePath = join(userDataPath, WAKE_BROKER_STATE_FILENAME)
  const publish =
    deps.publish ??
    ((targetPath: string, value: unknown) => writeDurableSecureJsonFile(targetPath, value))
  const now = deps.now ?? Date.now
  if (!existsSync(statePath)) {
    return {
      ok: true,
      store: createStore(statePath, { schema: STATE_SCHEMA, targets: [], grants: [] }, publish, now)
    }
  }
  let raw: string
  try {
    hardenExistingSecureFile(statePath)
    raw = readFileSync(statePath, 'utf-8')
  } catch (error) {
    // Why: an I/O failure says nothing about the bytes; leave them for the next start.
    console.error('[wake-broker] state file could not be read:', (error as Error).message)
    return { ok: false, reason: 'wake_broker_state_io_failed' }
  }
  const state = parseState(raw)
  if (!state) {
    // Why: unreadable is unknown, not empty; keep the bytes and fail closed so nothing publishes over them.
    try {
      renameSync(statePath, `${statePath}.corrupt-${now()}`)
    } catch (error) {
      console.error(
        '[wake-broker] unreadable state file could not be preserved:',
        (error as Error).message
      )
    }
    return { ok: false, reason: 'wake_broker_state_unreadable' }
  }
  return { ok: true, store: createStore(statePath, state, publish, now) }
}
