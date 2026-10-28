/**
 * Out-of-band power contract. There is no production implementation: this AMD host has no AMT (M4 HARDWARE_BOUND).
 * `can-power-on-oob` (host-oob-verdict.ts) measures whether one could exist on a given host.
 * `powerOn` never reports more than command-accepted; only the host's own live answer says it is on.
 */
export type OobPowerState = 'on' | 'off' | 'unknown'

export const OOB_POWER_RESULT_STAGES = ['command-accepted'] as const

export const OOB_POWER_REFUSAL_CODES = [
  'oob_unavailable',
  'oob_refused',
  'oob_unreachable'
] as const

export type OobPowerResult =
  | { ok: true; stage: (typeof OOB_POWER_RESULT_STAGES)[number] }
  | { ok: false; code: (typeof OOB_POWER_REFUSAL_CODES)[number] }

export type OobPowerController = {
  powerOn(targetId: string): Promise<OobPowerResult>
  readPowerState(targetId: string): Promise<{ state: OobPowerState; observedAt: number }>
}
