import { hostPickerOptions, type HostPickerOption } from '../transport/host-picker-options'
import type { ConnectionState, HostProfile } from '../transport/types'
import { MOBILE_SESSION_STATUS_LABELS } from './mobile-session-route-helpers'

/** Switch-host rows: most recently connected first, state before the endpoint. */
export function switchHostPickerOptions(
  hosts: readonly HostProfile[],
  states: ReadonlyMap<string, ConnectionState>
): HostPickerOption[] {
  const ordered = [...hosts].sort(
    (left, right) => right.lastConnected - left.lastConnected || left.id.localeCompare(right.id)
  )
  return hostPickerOptions(ordered).map((option) => {
    const state = states.get(option.value)
    // A host with no client has not been reached this run; that is not a failure.
    const stateLabel = state ? MOBILE_SESSION_STATUS_LABELS[state] : 'Not connected'
    return { ...option, subtitle: `${stateLabel} · ${option.subtitle}` }
  })
}
