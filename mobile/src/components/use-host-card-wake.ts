import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { HomeHostStatusSnapshot } from '../transport/home-host-status-fetch'
import {
  brokerRouteInputs,
  fetchHomeHostWakeTargets,
  hostKeyOfPublicKey,
  hostsAskableForWakeTargets,
  pressHostWake,
  type HomeHostWakeTargetsSnapshot,
  type HostWakeClientEntry
} from '../transport/home-host-wake-session'
import type { ConnectionState } from '../transport/types'
import type { HostCardWakeAttempt, HostCardWakeInputs } from './host-availability-presentation'

type WakeCardHost = { id: string; publicKeyB64: string }
type TargetsByHost = Record<string, HomeHostWakeTargetsSnapshot>

export type HostCardWakeSession = {
  wakeFor: (host: WakeCardHost) => HostCardWakeInputs
  pressWake: (host: WakeCardHost) => void
}

// Why React state only: broker answers and wakes prove something for this session alone (D-03).
export function useHostCardWake(input: {
  allClientsRef: { readonly current: readonly HostWakeClientEntry[] }
  hostStates: Record<string, ConnectionState>
  hostLastConnected: Record<string, number | null>
  hostStatusSnapshots: Record<string, HomeHostStatusSnapshot>
}): HostCardWakeSession {
  const { allClientsRef, hostStates, hostLastConnected, hostStatusSnapshots } = input
  const [targetsByHost, setTargetsByHost] = useState<TargetsByHost>({})
  const [attempts, setAttempts] = useState<Record<string, HostCardWakeAttempt>>({})
  const askedAtRef = useRef(new Map<string, number>())
  const inFlightRef = useRef(new Set<string>())
  const unmountedRef = useRef(false)

  useEffect(() => {
    unmountedRef.current = false
    return () => {
      unmountedRef.current = true
    }
  }, [])

  useEffect(() => {
    const askable = hostsAskableForWakeTargets({
      clients: allClientsRef.current,
      statuses: hostStatusSnapshots,
      targets: targetsByHost
    })
    for (const { hostId, client } of askable) {
      const status = hostStatusSnapshots[hostId]
      // Why: one ask per status answer, even while the first ask is still on the wire.
      if (!status || askedAtRef.current.get(hostId) === status.observedAt) {
        continue
      }
      askedAtRef.current.set(hostId, status.observedAt)
      void fetchHomeHostWakeTargets(client, hostId, setTargetsByHost, () => unmountedRef.current)
    }
  }, [allClientsRef, hostStates, hostStatusSnapshots, targetsByHost])

  const brokers = useMemo(
    () =>
      brokerRouteInputs(
        Object.keys(hostStatusSnapshots).map((hostId) => ({
          hostId,
          connected: hostStates[hostId] === 'connected',
          lastConnectedAt: hostLastConnected[hostId] ?? null,
          status: hostStatusSnapshots[hostId],
          targets: targetsByHost[hostId]
        }))
      ),
    [hostStates, hostLastConnected, hostStatusSnapshots, targetsByHost]
  )

  const wakeFor = useCallback(
    (host: WakeCardHost): HostCardWakeInputs => ({
      hostKey: hostKeyOfPublicKey(host.publicKeyB64),
      brokers,
      attempt: attempts[host.id] ?? null
    }),
    [attempts, brokers]
  )

  const pressWake = useCallback(
    (host: WakeCardHost) => {
      // Why: the busy control already refuses; this guards a double tap before the re-render.
      if (inFlightRef.current.has(host.id)) {
        return
      }
      const store = (attempt: HostCardWakeAttempt) => {
        if (!unmountedRef.current) {
          setAttempts((prev) => ({ ...prev, [host.id]: attempt }))
        }
      }
      const pending = pressHostWake({
        target: host,
        brokers,
        clients: allClientsRef.current,
        now: () => Date.now(),
        onPressed: store
      })
      if (pending === null) {
        return
      }
      inFlightRef.current.add(host.id)
      void pending.then(store).finally(() => inFlightRef.current.delete(host.id))
    },
    [allClientsRef, brokers]
  )

  return { wakeFor, pressWake }
}
