import { sha256 } from '@noble/hashes/sha256'
import * as ExpoCrypto from 'expo-crypto'
import {
  composeHostWakeRoute,
  hostKeyFromPublicKeyB64,
  parseHostWakeTargetsReply,
  type WakeRouteBroker
} from '../../../src/shared/host-wake-proxy'
import { HOST_WAKE_BROKER_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import type { HostCardWakeAttempt } from '../components/host-availability-presentation'
import { isTargetObservedStage, wakeAttemptFurthestStage } from '../components/host-card-wake-stage'
import type { HomeHostStatusSnapshot } from './home-host-status-fetch'
import { sendSingleFlightRequest } from './request-single-flight'
import type { RpcClient, SendRequestOptions } from './rpc-client'
import { isLogicalClientCutoverError } from './stable-logical-rpc-client'
import type { ConnectionState, RpcResponse } from './types'

// Why: same cutover cap as fetchHomeHostStatus, so a relay↔direct migration loop cannot spin.
const CUTOVER_RETRY_LIMIT = 2
// Why: a refusal without a string code, or a send that never answered, is unknown, never a stage.
const UNKNOWN_REFUSAL_CODE = 'unknown'
// Why no connect wait and one budget: a parked press would send a stale wake after a later reconnect (WR-02).
const HOST_WAKE_RPC_OPTIONS: SendRequestOptions = {
  timeoutMs: 10_000,
  budgetSpansConnect: true,
  failWhenDisconnected: true
}

export type HomeHostWakeTargetsSnapshot = { observedAt: number; targets: unknown }

export type HomeHostWakeTargetsSetter = (
  updater: (
    prev: Record<string, HomeHostWakeTargetsSnapshot>
  ) => Record<string, HomeHostWakeTargetsSnapshot>
) => void

export type HostWakeClientEntry = { hostId: string; client: RpcClient }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Why the host's own rule: a card's key must equal the fingerprint a broker binding names (21-02 vector).
export function hostKeyOfPublicKey(publicKeyB64: string): string | null {
  return hostKeyFromPublicKeyB64(publicKeyB64, (bytes) => sha256(bytes))
}

export function advertisesWakeBroker(snapshot: HomeHostStatusSnapshot | undefined): boolean {
  const result = snapshot?.result
  return (
    isRecord(result) &&
    Array.isArray(result.capabilities) &&
    result.capabilities.includes(HOST_WAKE_BROKER_RUNTIME_CAPABILITY)
  )
}

// Why per status answer: a broker is asked again only after it answered status.get again.
export function shouldFetchWakeTargets(
  status: HomeHostStatusSnapshot | undefined,
  targets: HomeHostWakeTargetsSnapshot | undefined
): boolean {
  if (status === undefined || !advertisesWakeBroker(status)) {
    return false
  }
  return targets === undefined || targets.observedAt < status.observedAt
}

export function hostsAskableForWakeTargets(input: {
  clients: readonly HostWakeClientEntry[]
  statuses: Record<string, HomeHostStatusSnapshot>
  targets: Record<string, HomeHostWakeTargetsSnapshot>
}): HostWakeClientEntry[] {
  return input.clients.filter(
    (entry) =>
      entry.client.getState() === 'connected' &&
      shouldFetchWakeTargets(input.statuses[entry.hostId], input.targets[entry.hostId])
  )
}

/** Reads one broker's host.wake.targets for this session; a failed read keeps the previous answer. */
export function fetchHomeHostWakeTargets(
  client: RpcClient,
  hostId: string,
  setTargets: HomeHostWakeTargetsSetter,
  disposed: () => boolean
): Promise<void> {
  const attempt = (cutoverRetriesLeft: number): Promise<void> =>
    sendSingleFlightRequest(client, hostId, 'host.wake.targets', undefined)
      .then((response) => {
        if (disposed() || !response.ok) {
          return
        }
        // Why null on a malformed answer: the composer then reads it as unreadable, never as targets.
        const snapshot: HomeHostWakeTargetsSnapshot = {
          observedAt: Date.now(),
          targets: parseHostWakeTargetsReply(response.result)
        }
        setTargets((prev) => ({ ...prev, [hostId]: snapshot }))
      })
      .catch((error: unknown) => {
        if (disposed()) {
          return
        }
        if (cutoverRetriesLeft > 0 && isLogicalClientCutoverError(error)) {
          return attempt(cutoverRetriesLeft - 1)
        }
      })

  return attempt(CUTOVER_RETRY_LIMIT)
}

export function brokerRouteInputs(
  hosts: ReadonlyArray<{
    hostId: string
    connected: boolean
    lastConnectedAt: number | null
    status: HomeHostStatusSnapshot | undefined
    targets: HomeHostWakeTargetsSnapshot | undefined
  }>
): WakeRouteBroker[] {
  return hosts.map((host) => ({
    brokerHostId: host.hostId,
    inputs: {
      broker: { connected: host.connected, lastConnectedAt: host.lastConnectedAt },
      status: host.status ?? null,
      targets: host.targets ?? null
    }
  }))
}

export type HostWakePressPlan = {
  client: RpcClient
  brokerHostId: string
  targetId: string
  hostKey: string
}

// Why recompose at press time: the route the card drew may be stale; only the composer may pick a broker.
export function planHostWakePress(input: {
  targetHostId: string
  hostKey: string | null
  brokers: readonly WakeRouteBroker[]
  clients: readonly HostWakeClientEntry[]
}): HostWakePressPlan | null {
  const route = composeHostWakeRoute(input)
  if (!route.send || input.hostKey === null) {
    return null
  }
  const entry = input.clients.find((candidate) => candidate.hostId === route.brokerHostId)
  // Why the live client state: the route was composed from a React snapshot that may already be stale.
  if (!entry || entry.client.getState() !== 'connected') {
    return null
  }
  // Why the card's key: the broker refuses wake_target_rebound when the target no longer names this host (WR-03).
  return {
    client: entry.client,
    brokerHostId: route.brokerHostId,
    targetId: route.targetId,
    hostKey: input.hostKey
  }
}

function refusalCodeOf(error: { code?: unknown }): string {
  return typeof error.code === 'string' && error.code !== '' ? error.code : UNKNOWN_REFUSAL_CODE
}

// Why no revocation check here: a wake_* refusal is this attempt's state, never the pairing's.
export async function requestHostWake(input: {
  client: RpcClient
  brokerHostId: string
  targetId: string
  hostKey: string
  requestId: string
  now: () => number
  onPressed?: (attempt: HostCardWakeAttempt) => void
}): Promise<HostCardWakeAttempt> {
  const pressed: HostCardWakeAttempt = {
    brokerHostId: input.brokerHostId,
    targetId: input.targetId,
    requestId: input.requestId,
    pressedAt: input.now(),
    repliedAt: null,
    wakeId: null,
    brokerStages: null,
    refusalCode: null
  }
  input.onPressed?.(pressed)
  let response: RpcResponse
  try {
    response = await input.client.sendRequest(
      'host.wake.request',
      { targetId: input.targetId, requestId: input.requestId, hostKey: input.hostKey },
      HOST_WAKE_RPC_OPTIONS
    )
  } catch {
    // Why unknown: a timed-out send may have reached the broker; a refused-while-disconnected one ends busy.
    return { ...pressed, repliedAt: input.now(), refusalCode: UNKNOWN_REFUSAL_CODE }
  }
  const repliedAt = input.now()
  if (!response.ok) {
    return { ...pressed, repliedAt, refusalCode: refusalCodeOf(response.error) }
  }
  const result = isRecord(response.result) ? response.result : {}
  return {
    ...pressed,
    repliedAt,
    wakeId: typeof result.wakeId === 'string' ? result.wakeId : null,
    brokerStages: result.stages
  }
}

// Why the id is minted here: every press is its own request; a reused id would replay the old wake.
export function pressHostWake(input: {
  target: { id: string; publicKeyB64: string }
  brokers: readonly WakeRouteBroker[]
  clients: readonly HostWakeClientEntry[]
  now: () => number
  onPressed?: (attempt: HostCardWakeAttempt) => void
}): Promise<HostCardWakeAttempt> | null {
  const plan = planHostWakePress({
    targetHostId: input.target.id,
    hostKey: hostKeyOfPublicKey(input.target.publicKeyB64),
    brokers: input.brokers,
    clients: input.clients
  })
  if (plan === null) {
    return null
  }
  return requestHostWake({
    ...plan,
    requestId: ExpoCrypto.randomUUID(),
    now: input.now,
    onPressed: input.onPressed
  })
}

// Why repliedAt stays: the press reply is the phone-observed anchor the presenter rebases stages to.
export async function readHostWakeStatus(input: {
  client: RpcClient
  attempt: HostCardWakeAttempt
}): Promise<HostCardWakeAttempt> {
  const { attempt } = input
  if (attempt.wakeId === null) {
    return attempt
  }
  let response: RpcResponse
  try {
    response = await input.client.sendRequest(
      'host.wake.status',
      { wakeId: attempt.wakeId },
      HOST_WAKE_RPC_OPTIONS
    )
  } catch {
    // Why keep: a read that never answered says nothing about the wake.
    return attempt
  }
  if (!response.ok) {
    // Why not refusalCode: the press already has its outcome; this read only failed (WR-01).
    return { ...attempt, statusReadCode: refusalCodeOf(response.error) }
  }
  const result = isRecord(response.result) ? response.result : {}
  return { ...attempt, brokerStages: result.stages }
}

function brokerStageNames(brokerStages: unknown): string[] {
  if (!Array.isArray(brokerStages)) {
    return []
  }
  return brokerStages.flatMap((record: unknown) =>
    isRecord(record) && typeof record.stage === 'string' ? [record.stage] : []
  )
}

// Why: a refusal, a failed send or a closed status read is final; a sent packet waits for the target.
export function isWakeAttemptTerminal(attempt: HostCardWakeAttempt): boolean {
  return (
    attempt.refusalCode !== null ||
    attempt.statusReadCode !== undefined ||
    brokerStageNames(attempt.brokerStages).includes('packet-send-failed')
  )
}

export type HostWakeRefresh = { targetHostId: string; attempt: HostCardWakeAttempt }

// The card's own inputs per target host id, the same ones the presenter reads.
export type WakeTargetObservations = {
  statuses: Record<string, HomeHostStatusSnapshot>
  lastConnected: Record<string, number | null>
}

function targetAnswered(
  targetHostId: string,
  attempt: HostCardWakeAttempt,
  observations: WakeTargetObservations
): boolean {
  return isTargetObservedStage(
    wakeAttemptFurthestStage(
      attempt,
      observations.statuses[targetHostId],
      observations.lastConnected[targetHostId] ?? null
    )
  )
}

// Why: focus re-reads only a named wake that can still change and whose target has not answered.
export function wakesToRefresh(
  attempts: Record<string, HostCardWakeAttempt>,
  observations: WakeTargetObservations
): HostWakeRefresh[] {
  return Object.entries(attempts).flatMap(([targetHostId, attempt]) =>
    attempt.repliedAt !== null &&
    attempt.wakeId !== null &&
    !isWakeAttemptTerminal(attempt) &&
    !targetAnswered(targetHostId, attempt, observations)
      ? [{ targetHostId, attempt }]
      : []
  )
}

export type WakeAttemptEnd = { targetHostId: string; requestId: string }

// Why: once the target answered and then dropped, that wake's evidence describes a past boot (IN-02).
export function endedWakeAttempts(
  attempts: Record<string, HostCardWakeAttempt>,
  observations: WakeTargetObservations & { hostStates: Record<string, ConnectionState> }
): WakeAttemptEnd[] {
  return Object.entries(attempts).flatMap(([targetHostId, attempt]) =>
    observations.hostStates[targetHostId] !== 'connected' &&
    targetAnswered(targetHostId, attempt, observations)
      ? [{ targetHostId, requestId: attempt.requestId }]
      : []
  )
}

// Why the pressed key: a re-pair under another key is another host identity, not this wake's target.
export function wakeAttemptForPairing(input: {
  attempt: HostCardWakeAttempt | undefined
  pressedHostKey: string | null | undefined
  hostKey: string | null
}): HostCardWakeAttempt | null {
  return input.attempt !== undefined && input.pressedHostKey === input.hostKey
    ? input.attempt
    : null
}
