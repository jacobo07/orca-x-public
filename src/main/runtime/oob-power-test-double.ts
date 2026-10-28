// Tests only: a scripted recorder. Production must never import it (the sweep in oob-power.test.ts pins that).
import type { OobPowerController, OobPowerResult, OobPowerState } from './oob-power'

export type RecordedOobCall = { op: 'powerOn' | 'readPowerState'; targetId: string }

export function createRecordingOobPowerController(script: {
  powerOn: OobPowerResult[]
  states: OobPowerState[]
  now: () => number
}): OobPowerController & { calls: RecordedOobCall[] } {
  const results = [...script.powerOn]
  const states = [...script.states]
  const calls: RecordedOobCall[] = []
  return {
    calls,
    async powerOn(targetId) {
      calls.push({ op: 'powerOn', targetId })
      const next = results.shift()
      if (next === undefined) {
        throw new Error('powerOn called more times than the script provides')
      }
      return next
    },
    async readPowerState(targetId) {
      calls.push({ op: 'readPowerState', targetId })
      const state = states.shift()
      if (state === undefined) {
        throw new Error('readPowerState called more times than the script provides')
      }
      return { state, observedAt: script.now() }
    }
  }
}
