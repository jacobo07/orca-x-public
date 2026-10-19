import { TERMINAL_TEXT_SCALES } from '../storage/preferences'

export const TERMINAL_TEXT_SCALE_RESET = 1

export function nextTerminalTextScale(current: number): number {
  const presets = TERMINAL_TEXT_SCALES as readonly number[]
  const at = presets.indexOf(current)
  const from = at === -1 ? presets.indexOf(TERMINAL_TEXT_SCALE_RESET) : at
  return presets[(from + 1) % presets.length]!
}
