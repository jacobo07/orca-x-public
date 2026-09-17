import { ipcMain } from 'electron'
import {
  LIVE_AGENT_SESSION_PRESENCE_CHANNEL,
  LIVE_SESSION_MATERIALIZATION_ATTACH_CHANNEL,
  LIVE_SESSION_MATERIALIZATION_RELEASE_CHANNEL,
  LIVE_SESSION_MATERIALIZATION_RESERVE_CHANNEL,
  isMaterializationOperationId,
  parseLiveAgentSessionPresenceRequest,
  parseLiveSessionMaterializationRequest,
  type LiveAgentSessionPresenceResponse,
  type LiveSessionMaterializationResponse
} from '../../shared/live-agent-session-presence-types'
import { parsePaneKey } from '../../shared/stable-pane-id'
import type { LiveAgentSessionPresenceReaderDeps } from '../agent-hooks/live-agent-session-presence-reader'
import type { LiveSessionMaterializationReservations } from '../agent-hooks/live-session-materialization-reservation'
import {
  installResumeSpawnGate,
  type ResumeSpawnSender
} from '../agent-hooks/resume-spawn-gate-slot'
import { decideResumeSpawn } from './agent-session-resume-spawn-gate'
import {
  UNREADABLE_PRESENCE as UNREADABLE_REQUEST,
  isClearPresence as isClear,
  readPresence,
  toPresenceResponse as toResponse
} from './live-agent-session-presence-response'

const MAX_TAB_ID_LENGTH = 512
/** Owner of spawns main started itself; no window can release or outlive them. */
const NO_SPAWN_OWNER = -1

/** Answers where a provider session is live. A malformed request or a failed read is
 *  `unknown`, never `no-live-owner`: absence of an answer is not absence of an owner. */
export async function handleLiveAgentSessionPresenceRequest(
  deps: LiveAgentSessionPresenceReaderDeps,
  value: unknown
): Promise<LiveAgentSessionPresenceResponse> {
  const request = parseLiveAgentSessionPresenceRequest(value)
  if (!request) {
    return UNREADABLE_REQUEST
  }
  const presence = await readPresence(deps, request)
  return presence ? toResponse(presence) : UNREADABLE_REQUEST
}
function materializing(
  base: LiveAgentSessionPresenceResponse,
  holderOperationId: string
): LiveAgentSessionPresenceResponse {
  return { ...base, kind: 'materializing', ownersRevision: `materializing:${holderOperationId}` }
}

/** Grants one operation the right to materialize a session, or says why not. The presence
 *  read is advisory; the synchronous check-and-set after it is the authority, so two
 *  attempts that both read "no owner" still cannot both be granted. */
export async function handleLiveSessionMaterializationRequest(
  deps: LiveAgentSessionPresenceReaderDeps,
  reservations: LiveSessionMaterializationReservations,
  ownerId: number,
  value: unknown
): Promise<LiveSessionMaterializationResponse> {
  const request = parseLiveSessionMaterializationRequest(value)
  if (!request) {
    return { outcome: 'blocked', presence: UNREADABLE_REQUEST }
  }
  const reading = await readPresence(deps, request)
  if (!reading) {
    return { outcome: 'blocked', presence: UNREADABLE_REQUEST }
  }
  // Nothing below awaits: the reservation state read here is the state written here.
  const key = reading.subjectKey
  const base = toResponse(reading)
  if (key) {
    // Why: a live owner in the reserved tab is the handoff; presence now owns the truth.
    for (const paneKey of reading.liveElsewhere) {
      const tabId = parsePaneKey(paneKey)?.tabId
      if (tabId) {
        reservations.releaseForTab(tabId)
      }
    }
  }
  const holder = key ? reservations.holder(key) : null
  const foreignHolder =
    holder && (holder.operationId !== request.operationId || holder.ownerId !== ownerId)
      ? holder
      : null
  // Why: live, multiple and unknown owners outrank an attempt that has not started yet.
  const effective =
    foreignHolder && isClear(base.kind) ? materializing(base, foreignHolder.operationId) : base
  const accepted =
    request.accept?.kind === effective.kind &&
    request.accept.ownersRevision === effective.ownersRevision
  if (!isClear(effective.kind) && !accepted) {
    return { outcome: 'blocked', presence: effective }
  }
  if (!key) {
    return { outcome: 'granted', presence: effective }
  }
  // Why: the spawn gate re-checks at the effect; the consent travels there as a one-shot permit.
  const consented = !isClear(effective.kind)
  if (effective.kind === 'materializing') {
    // Why: an accepted in-flight collision is an explicit one-shot duplicate that must not displace the holder.
    return reservations.grantPermit(key, request.operationId, ownerId)
      ? { outcome: 'granted', presence: effective }
      : { outcome: 'blocked', presence: UNREADABLE_REQUEST }
  }
  const acquired = reservations.tryAcquire(key, request.operationId, ownerId)
  if (acquired === 'granted' || acquired === 'held-by-self') {
    if (consented) {
      reservations.grantPermit(key, request.operationId, ownerId)
    }
    return { outcome: 'granted', presence: effective }
  }
  if (acquired === 'contended' && foreignHolder) {
    return { outcome: 'blocked', presence: materializing(base, foreignHolder.operationId) }
  }
  return { outcome: 'blocked', presence: UNREADABLE_REQUEST }
}

function parseAttach(value: unknown): { operationId: string; tabId: string } | null {
  const raw = value as Record<string, unknown> | null
  if (
    !raw ||
    typeof raw !== 'object' ||
    !isMaterializationOperationId(raw.operationId) ||
    typeof raw.tabId !== 'string' ||
    raw.tabId.length === 0 ||
    raw.tabId.length > MAX_TAB_ID_LENGTH ||
    raw.tabId.includes(':')
  ) {
    return null
  }
  return { operationId: raw.operationId, tabId: raw.tabId }
}

export function registerAgentSessionLivePresenceHandlers(
  resolveDeps: () => LiveAgentSessionPresenceReaderDeps,
  resolveReservations: () => LiveSessionMaterializationReservations
): void {
  // Why: no removeHandler first — a second registration must fail loudly, not steal the channel.
  ipcMain.handle(LIVE_AGENT_SESSION_PRESENCE_CHANNEL, (_event, value: unknown) =>
    handleLiveAgentSessionPresenceRequest(resolveDeps(), value)
  )
  const watchedSenders = new Set<number>()
  const ownerOf = (sender: ResumeSpawnSender): number => {
    if (!watchedSenders.has(sender.id)) {
      watchedSenders.add(sender.id)
      // Why: a closed window's attempts can never hand off; drop them with it.
      sender.once('destroyed', () => {
        watchedSenders.delete(sender.id)
        resolveReservations().releaseForOwner(sender.id)
      })
    }
    return sender.id
  }
  ipcMain.handle(LIVE_SESSION_MATERIALIZATION_RESERVE_CHANNEL, (event, value: unknown) =>
    handleLiveSessionMaterializationRequest(
      resolveDeps(),
      resolveReservations(),
      ownerOf(event.sender),
      value
    )
  )
  ipcMain.handle(LIVE_SESSION_MATERIALIZATION_ATTACH_CHANNEL, (event, value: unknown) => {
    const attach = parseAttach(value)
    return attach
      ? resolveReservations().attachTab(attach.operationId, ownerOf(event.sender), attach.tabId)
      : false
  })
  ipcMain.handle(LIVE_SESSION_MATERIALIZATION_RELEASE_CHANNEL, (event, value: unknown) => {
    const operationId = (value as { operationId?: unknown } | null)?.operationId
    if (isMaterializationOperationId(operationId)) {
      resolveReservations().release(operationId, ownerOf(event.sender))
    }
  })
  installMainResumeSpawnGate(resolveDeps, resolveReservations, ownerOf)
}

/** Installs the spawn gate. Headless serve calls this without IPC: runtime ensure still resumes
 *  there, and a host with no gate would let every such resume through unchecked. */
export function installMainResumeSpawnGate(
  resolveDeps: () => LiveAgentSessionPresenceReaderDeps,
  resolveReservations: () => LiveSessionMaterializationReservations,
  ownerOf: (sender: ResumeSpawnSender) => number = () => NO_SPAWN_OWNER
): void {
  const spawnOwner = (sender: ResumeSpawnSender | null): number =>
    sender ? ownerOf(sender) : NO_SPAWN_OWNER
  installResumeSpawnGate({
    decide: ({ sender, ...request }) =>
      decideResumeSpawn(resolveDeps(), resolveReservations(), {
        ...request,
        ownerId: spawnOwner(sender)
      }),
    release: (operationId, sender) => resolveReservations().release(operationId, spawnOwner(sender))
  })
}
