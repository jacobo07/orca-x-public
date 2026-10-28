import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import { isIPv4 } from 'node:net'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { hardenExistingSecureFile, writeDurableSecureJsonFile } from '../../shared/secure-file'
import { hostWakeRefusal, isHostKey } from '../../shared/host-wake'
import { normalizeMac } from './wake-magic-packet'
import type { WakeBrokerStoreView, WakeTarget } from './wake-broker'
import {
  emptyWakeBrokerState,
  ID_MAX,
  isPort,
  LABEL_MAX,
  parseWakeBrokerState,
  type WakeBrokerState,
  type WakeGrant
} from './wake-broker-state-schema'

export type { WakeGrant } from './wake-broker-state-schema'

export const WAKE_BROKER_STATE_FILENAME = 'orca-wake-broker.json'

export type WakeTargetInput = { mac: string; broadcast: string; port: number; label: string }

export type WakeBrokerStore = WakeBrokerStoreView & {
  grants(): WakeGrant[]
  addTarget(input: WakeTargetInput): WakeTarget
  removeTarget(targetId: string): boolean
  bindTarget(targetId: string, hostKey: string | null): WakeTarget
  addGrant(deviceId: string, targetId: string): WakeGrant
  removeGrant(deviceId: string, targetId: string): boolean
  dropGrantsForDevice(deviceId: string): number
  pruneGrants(keepDevice: (deviceId: string) => boolean): number
}

export type WakeBrokerStoreLoad =
  | { ok: true; store: WakeBrokerStore; previousStateMovedAside?: string }
  | {
      ok: false
      reason:
        | 'wake_broker_state_unreadable'
        | 'wake_broker_state_io_failed'
        | 'wake_broker_state_newer_schema'
    }

const MOVED_ASIDE_PREFIX = `${WAKE_BROKER_STATE_FILENAME}.corrupt-`

export type WakeBrokerStoreDeps = {
  publish?: (targetPath: string, value: unknown) => void
  now?: () => number
}

function invalidArgument(message: string): Error {
  return Object.assign(new Error(message), { code: 'invalid_argument' })
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

const STORAGE_ERROR_CODE = /^[A-Za-z0-9_]{1,64}$/

function storageErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && STORAGE_ERROR_CODE.test(code) ? code : 'publish_failed'
}

function readStateAfterFailedPublish(statePath: string): WakeBrokerState | null {
  let raw: string
  try {
    raw = readFileSync(statePath, 'utf-8')
  } catch (error) {
    // Why ENOENT is empty: before the first addition there is no file, and a missing file loads as empty.
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? emptyWakeBrokerState() : null
  }
  const parsed = parseWakeBrokerState(raw)
  return parsed === 'newer_schema' ? null : parsed
}

function createStore(
  statePath: string,
  initial: WakeBrokerState,
  publish: (targetPath: string, value: unknown) => void,
  now: () => number
): WakeBrokerStore {
  let state = initial

  // Why disk first: an addition is not valid until it is durable.
  // Why reconcile on a throw: writeSecureFile can fail after its rename (chmod, directory fsync), and an addition
  // already on disk loads on restart, so it must never be reported as a definite failure (IN-05).
  function commitAddition(next: WakeBrokerState): void {
    try {
      publish(statePath, next)
    } catch (error) {
      const onDisk = readStateAfterFailedPublish(statePath)
      if (onDisk && isDeepStrictEqual(onDisk, state)) {
        throw error
      }
      const active = onDisk !== null && isDeepStrictEqual(onDisk, next)
      if (active) {
        state = next
      }
      const cause = storageErrorCode(error)
      console.error(`[wake-broker] state publish failed after it may have landed: ${cause}`)
      throw hostWakeRefusal(
        'wake_broker_state_indeterminate',
        active
          ? 'The change is on disk and active, but its write did not finish cleanly, so it may not survive a power loss.'
          : 'The write failed and the state on disk could not be confirmed; the change is not active in this broker.',
        { active, cause }
      )
    }
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

    bindTarget(targetId, hostKey) {
      const current = state.targets.find((target) => target.targetId === targetId)
      if (!current) {
        throw hostWakeRefusal('wake_target_unknown', 'That wake target is not registered.')
      }
      if (hostKey !== null && !isHostKey(hostKey)) {
        throw invalidArgument('hostKey must be a 43-character base64url host key fingerprint')
      }
      if ((current.hostKey ?? null) === hostKey) {
        return { ...current }
      }
      // Why: one host behind two targets of one broker is ambiguity at the source (D-04).
      const holder = state.targets.find((target) => hostKey !== null && target.hostKey === hostKey)
      if (holder) {
        throw invalidArgument(`hostKey is already bound to wake target ${holder.targetId}`)
      }
      const next: WakeTarget = { ...current }
      if (hostKey === null) {
        delete next.hostKey
      } else {
        next.hostKey = hostKey
      }
      const targets = state.targets.map((target) => (target === current ? next : target))
      // Why split: a binding is an addition (durable before active); an unbind is a removal (inactive at once).
      if (hostKey === null) {
        commitRemoval({ ...state, targets })
      } else {
        commitAddition({ ...state, targets })
      }
      return { ...next }
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

function latestMovedAsideState(userDataPath: string): string | undefined {
  if (!existsSync(userDataPath)) {
    return undefined
  }
  const stamp = (name: string): number => Number(name.slice(MOVED_ASIDE_PREFIX.length))
  return readdirSync(userDataPath)
    .filter((name) => name.startsWith(MOVED_ASIDE_PREFIX))
    .sort((a, b) => stamp(a) - stamp(b))
    .at(-1)
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
    let previousStateMovedAside: string | undefined
    try {
      // Why: after a quarantine the next start finds no file, and an empty broker must not read as a clean one (IN-04).
      previousStateMovedAside = latestMovedAsideState(userDataPath)
    } catch (error) {
      console.error('[wake-broker] userData could not be listed:', (error as Error).message)
      return { ok: false, reason: 'wake_broker_state_io_failed' }
    }
    const store = createStore(statePath, emptyWakeBrokerState(), publish, now)
    return previousStateMovedAside
      ? { ok: true, store, previousStateMovedAside }
      : { ok: true, store }
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
  const state = parseWakeBrokerState(raw)
  if (state === 'newer_schema') {
    // Why in place: an older Orca must never quarantine, and so lose, a newer host's targets and grants (IN-04).
    console.error('[wake-broker] state file was written by a newer Orca; leaving it untouched')
    return { ok: false, reason: 'wake_broker_state_newer_schema' }
  }
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
