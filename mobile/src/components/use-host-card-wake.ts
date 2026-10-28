import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { HomeHostStatusSnapshot } from '../transport/home-host-status-fetch'
import {
  brokerRouteInputs,
  endedWakeAttempts,
  fetchHomeHostWakeTargets,
  hostKeyOfPublicKey,
  hostsAskableForWakeTargets,
  pressHostWake,
  readHostWakeStatus,
  wakeAttemptForPairing,
  wakesToRefresh,
  type HomeHostWakeTargetsSnapshot,
  type HostWakeClientEntry,
  type WakeTargetObservations
} from '../transport/home-host-wake-session'
import type { ConnectionState } from '../transport/types'
import type { HostCardWakeAttempt, HostCardWakeInputs } from './host-availability-presentation'

type WakeCardHost = { id: string; publicKeyB64: string }
type TargetsByHost = Record<string, HomeHostWakeTargetsSnapshot>

export type HostCardWakeSession = {
  wakeFor: (host: WakeCardHost) => HostCardWakeInputs
  pressWake: (host: WakeCardHost) => void
  refreshWakes: (disposed: () => boolean) => void
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
  // The card key each attempt was pressed under (IN-02).
  const [pressedKeys, setPressedKeys] = useState<Record<string, string | null>>({})
  // Why a ref: the focus callback stays stable yet reads the latest attempts.
  const attemptsRef = useRef(attempts)
  attemptsRef.current = attempts
  // Why a ref: the stable focus callback judges "target answered" on the latest card inputs.
  const observationsRef = useRef<WakeTargetObservations>({
    statuses: hostStatusSnapshots,
    lastConnected: hostLastConnected
  })
  observationsRef.current = { statuses: hostStatusSnapshots, lastConnected: hostLastConnected }
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

  // Why prune, not hide: a target that answered and dropped would otherwise re-show it on its next connect.
  useEffect(() => {
    const ended = endedWakeAttempts(attempts, {
      hostStates,
      statuses: hostStatusSnapshots,
      lastConnected: hostLastConnected
    })
    if (ended.length === 0) {
      return
    }
    setAttempts((prev) => {
      const next = { ...prev }
      for (const { targetHostId, requestId } of ended) {
        // Why match requestId: a newer press on the same card is not the wake that ended.
        if (next[targetHostId]?.requestId === requestId) {
          delete next[targetHostId]
        }
      }
      return next
    })
  }, [attempts, hostStates, hostStatusSnapshots, hostLastConnected])

  const wakeFor = useCallback(
    (host: WakeCardHost): HostCardWakeInputs => {
      const hostKey = hostKeyOfPublicKey(host.publicKeyB64)
      const paired = wakeAttemptForPairing({
        attempt: attempts[host.id],
        pressedHostKey: pressedKeys[host.id],
        hostKey
      })
      const observations = {
        hostStates,
        statuses: hostStatusSnapshots,
        lastConnected: hostLastConnected
      }
      // Why also here: the pruning effect runs after paint; the ended wake must not flash first.
      const ended =
        paired !== null && endedWakeAttempts({ [host.id]: paired }, observations).length > 0
      return { hostKey, brokers, attempt: ended ? null : paired }
    },
    [attempts, brokers, pressedKeys, hostStates, hostStatusSnapshots, hostLastConnected]
  )

  const pressWake = useCallback(
    (host: WakeCardHost) => {
      // Why: the busy control already refuses; this guards a double tap before the re-render.
      if (inFlightRef.current.has(host.id)) {
        return
      }
      const hostKey = hostKeyOfPublicKey(host.publicKeyB64)
      const store = (attempt: HostCardWakeAttempt) => {
        if (!unmountedRef.current) {
          setAttempts((prev) => ({ ...prev, [host.id]: attempt }))
          setPressedKeys((prev) => ({ ...prev, [host.id]: hostKey }))
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

  // Why no timer: progress is re-read on focus; the target's own reconnect supplies host-announced (D-07).
  const refreshWakes = useCallback(
    (disposed: () => boolean) => {
      for (const { targetHostId, attempt } of wakesToRefresh(
        attemptsRef.current,
        observationsRef.current
      )) {
        const broker = allClientsRef.current.find((entry) => entry.hostId === attempt.brokerHostId)
        if (!broker || broker.client.getState() !== 'connected') {
          continue
        }
        void readHostWakeStatus({ client: broker.client, attempt }).then((next) => {
          if (disposed() || unmountedRef.current) {
            return
          }
          // Why match requestId: an older read must not overwrite a newer press on the same card.
          setAttempts((prev) =>
            prev[targetHostId]?.requestId === attempt.requestId
              ? { ...prev, [targetHostId]: next }
              : prev
          )
        })
      }
    },
    [allClientsRef]
  )

  return { wakeFor, pressWake, refreshWakes }
}
