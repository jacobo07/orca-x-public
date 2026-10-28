export const HOST_WAKE_REFUSAL_CODES = [
  'wake_broker_disabled',
  'wake_broker_unavailable',
  'wake_device_required',
  'wake_device_revoked',
  'wake_device_unauthorized',
  'wake_device_unknown',
  'wake_grant_missing',
  'wake_target_unknown',
  // Why: the phone named a host the target is no longer bound to; the broker sent nothing (WR-03).
  'wake_target_rebound',
  'wake_send_failed',
  'wake_unknown',
  'wake_broker_state_indeterminate',
  // Why here: the passthrough must carry data.reason (not_ready | unavailable) to the Owner's CLI.
  'host_key_unavailable'
] as const

export type HostWakeRefusalCode = (typeof HOST_WAKE_REFUSAL_CODES)[number]

export const HOST_WAKE_STAGES = [
  'requested',
  'authorized',
  'packet-sent',
  'host-announced',
  'runtime-ready'
] as const

export type HostWakeStage = (typeof HOST_WAKE_STAGES)[number]

// Why: a packet sent is not a host woken (D-11); the broker may only ever write these.
export const HOST_WAKE_BROKER_STAGES = ['requested', 'authorized', 'packet-sent'] as const

export type HostWakeBrokerStage = (typeof HOST_WAKE_BROKER_STAGES)[number]

// Why: the card states that are neither stages nor refusal codes, so the claims gate can classify them.
export const HOST_WAKE_CARD_STATES = ['packet-send-failed', 'unknown', 'ambiguous-broker'] as const

export type HostWakeStageRecord = {
  stage: HostWakeStage | 'packet-send-failed'
  observedAt: number
  observer: 'broker' | 'client'
  code?: string
}

export type HostWakeRequestResult = {
  wakeId: string
  targetId: string
  replayed: boolean
  adopted: boolean
  stages: HostWakeStageRecord[]
}

export type HostWakeStatusResult = {
  wakeId: string
  targetId: string
  stages: HostWakeStageRecord[]
}

// Why hostKey only: a binding names the host by its E2EE key fingerprint, never a label, IP or runtimeId (D-01).
export type HostWakeTargetSummary = { targetId: string; label: string; hostKey?: string }

// sha256 of the host's E2EE public key, base64url without padding (fingerprintHostPublicKey).
export const HOST_KEY_FORM = /^[A-Za-z0-9_-]{43}$/

export function isHostKey(value: unknown): value is string {
  return typeof value === 'string' && HOST_KEY_FORM.test(value)
}

export const WAKE_DEFAULT_BROADCAST = '255.255.255.255'
export const WAKE_DEFAULT_PORT = 9
export const WAKE_TARGET_LABEL_MAX = 64

const MAC_FORM = /^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/i
const CONTROL_CHARACTER = /\p{Cc}/u

// Why shared: the CLI fails fast with the same rule the broker enforces at the method and the store.
export function normalizeMac(input: string): string | null {
  const trimmed = input.trim()
  return MAC_FORM.test(trimmed) ? trimmed.toLowerCase().replace(/-/g, ':') : null
}

export function isWakeTargetLabel(label: string): boolean {
  return (
    label.length >= 1 && label.length <= WAKE_TARGET_LABEL_MAX && !CONTROL_CHARACTER.test(label)
  )
}

export class HostWakeRefusal extends Error {
  readonly code: HostWakeRefusalCode
  readonly data?: Record<string, unknown>

  constructor(code: HostWakeRefusalCode, message: string, data?: Record<string, unknown>) {
    super(message)
    this.name = 'HostWakeRefusal'
    this.code = code
    if (data) {
      this.data = data
    }
  }
}

export function hostWakeRefusal(
  code: HostWakeRefusalCode,
  message: string,
  data?: Record<string, unknown>
): HostWakeRefusal {
  return new HostWakeRefusal(code, message, data)
}

const BROKER_WRITABLE_STAGES: ReadonlySet<string> = new Set([
  ...HOST_WAKE_BROKER_STAGES,
  'packet-send-failed'
])

function brokerRecord(value: unknown): HostWakeStageRecord | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const { stage, observedAt, code } = value as Record<string, unknown>
  if (typeof stage !== 'string' || !BROKER_WRITABLE_STAGES.has(stage)) {
    return null
  }
  if (typeof observedAt !== 'number' || !Number.isFinite(observedAt)) {
    return null
  }
  return {
    stage: stage as HostWakeStageRecord['stage'],
    observedAt,
    observer: 'broker',
    ...(typeof code === 'string' ? { code } : {})
  }
}

// Why: only the target's own live answer, observed after packet-sent, can say the host woke (D-11).
export function composeWakeProgress(
  brokerStages: unknown,
  targetAnswer: { observedAt: number; graphStatus?: string } | null
): HostWakeStageRecord[] {
  if (!Array.isArray(brokerStages)) {
    return []
  }
  const records = brokerStages
    .map(brokerRecord)
    .filter((record): record is HostWakeStageRecord => record !== null)
  const sent = records.find((record) => record.stage === 'packet-sent')
  if (!sent || !targetAnswer || !(targetAnswer.observedAt > sent.observedAt)) {
    return records
  }
  const announced: HostWakeStageRecord = {
    stage: 'host-announced',
    observedAt: targetAnswer.observedAt,
    observer: 'client'
  }
  if (targetAnswer.graphStatus !== 'ready') {
    return [...records, announced]
  }
  return [
    ...records,
    announced,
    { stage: 'runtime-ready', observedAt: targetAnswer.observedAt, observer: 'client' }
  ]
}
