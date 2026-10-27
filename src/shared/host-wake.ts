export const HOST_WAKE_REFUSAL_CODES = [
  'wake_broker_disabled',
  'wake_broker_unavailable',
  'wake_device_required',
  'wake_device_revoked',
  'wake_device_unauthorized',
  'wake_device_unknown',
  'wake_grant_missing',
  'wake_target_unknown',
  'wake_send_failed',
  'wake_unknown'
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

export type HostWakeTargetSummary = { targetId: string; label: string }

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
