import { useMemo, useRef } from 'react'
import { PickerModal } from '../components/PickerModal'
import type { ConnectionState, HostProfile } from '../transport/types'
import { useAllHostClients } from '../transport/use-all-host-clients'
import { switchHostPickerOptions } from './mobile-session-host-options'

type Props = {
  visible: boolean
  hosts: readonly HostProfile[]
  currentHostId: string
  onClose: () => void
  onSwitchHost: (hostId: string) => void
}

const NO_HOSTS: string[] = []
// Why: the picker reads states only; listing a host must never open a socket to it.
const OBSERVE_ONLY = { autoConnectHostIds: NO_HOSTS }

export function MobileSessionHostPicker({
  visible,
  hosts,
  currentHostId,
  onClose,
  onSwitchHost
}: Props) {
  const hostIds = useMemo(() => hosts.map((host) => host.id), [hosts])
  const observed = useAllHostClients(visible ? hostIds : NO_HOSTS, OBSERVE_ONLY)
  const states = useMemo(
    () => new Map<string, ConnectionState>(observed.map((entry) => [entry.hostId, entry.state])),
    [observed]
  )
  const pendingHostIdRef = useRef<string | null>(null)

  return (
    <PickerModal
      visible={visible}
      title="Switch host"
      options={switchHostPickerOptions(hosts, states)}
      selected={currentHostId}
      onSelect={(hostId) => {
        pendingHostIdRef.current = hostId === currentHostId ? null : hostId
      }}
      onClose={onClose}
      // Why: iOS cannot present the next route until the drawer's native window has unmounted.
      onAfterClose={() => {
        const hostId = pendingHostIdRef.current
        pendingHostIdRef.current = null
        if (hostId) {
          onSwitchHost(hostId)
        }
      }}
    />
  )
}
