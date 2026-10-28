import { isIPv4 } from 'node:net'
import { isHostKey } from '../../shared/host-wake'
import { normalizeMac } from './wake-magic-packet'
import type { WakeTarget } from './wake-broker'

export const STATE_SCHEMA = 1
export const LABEL_MAX = 64
export const ID_MAX = 128
const TARGET_ID_FORM = /^wt_[0-9a-f]{12}$/

export type WakeGrant = { deviceId: string; targetId: string; grantedAt: number }

export type WakeBrokerState = {
  schema: typeof STATE_SCHEMA
  targets: WakeTarget[]
  grants: WakeGrant[]
}

export function emptyWakeBrokerState(): WakeBrokerState {
  return { schema: STATE_SCHEMA, targets: [], grants: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function isPort(value: unknown): value is number {
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
    Number.isFinite(value.createdAt) &&
    // Why no schema bump: an older Orca keeps a well-formed key and projects nothing, while a bump would refuse the broker.
    (!('hostKey' in value) || isHostKey(value.hostKey))
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

function isNewerSchema(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.schema === 'number' &&
    Number.isInteger(value.schema) &&
    value.schema > STATE_SCHEMA
  )
}

export function parseWakeBrokerState(raw: string): WakeBrokerState | 'newer_schema' | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (isNewerSchema(value)) {
    return 'newer_schema'
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
