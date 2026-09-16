import { ipcMain } from 'electron'
import {
  LIVE_AGENT_SESSION_PRESENCE_CHANNEL,
  LIVE_SESSION_MATERIALIZATION_ATTACH_CHANNEL,
  LIVE_SESSION_MATERIALIZATION_RELEASE_CHANNEL,
  LIVE_SESSION_MATERIALIZATION_RESERVE_CHANNEL,
  isMaterializationOperationId,
  parseLiveAgentSessionPresenceRequest,
  parseLiveSessionMaterializationRequest,
  type LiveAgentSessionPresenceRequest,
  type LiveAgentSessionPresenceResponse,
  type LiveSessionMaterializationResponse
} from '../../shared/live-agent-session-presence-types'
import { parsePaneKey } from '../../shared/stable-pane-id'
import {
  readLiveAgentSessionPresence,
  type LiveAgentSessionPresenceReaderDeps,
  type LiveAgentSessionPresenceReading
} from '../agent-hooks/live-agent-session-presence-reader'
import type { LiveSessionMaterializationReservations } from '../agent-hooks/live-session-materialization-reservation'

const UNREADABLE_REQUEST: LiveAgentSessionPresenceResponse = {
  kind: 'unknown',
  liveElsewhere: [],
  ownersRevision: '',
  unknownCount: 0,
  staleCount: 0
}

const MAX_TAB_ID_LENGTH = 512

function ownersRevision(
  liveElsewhere: readonly string[],
  incarnationByPane: Record<string, string>
) {
  return [...liveElsewhere]
    .sort()
    .map((paneKey) => `${paneKey}@${incarnationByPane[paneKey] ?? ''}`)
    .join('|')
}

function toResponse(presence: LiveAgentSessionPresenceReading): LiveAgentSessionPresenceResponse {
  return {
    kind: presence.kind,
    liveElsewhere: presence.liveElsewhere,
    ownersRevision: ownersRevision(presence.liveElsewhere, presence.incarnationByPane),
    unknownCount: presence.unknown.length,
    staleCount: presence.stale.length
  }
}

/** Null when the read failed; the caller answers `unknown`. */
async function readPresence(
  deps: LiveAgentSessionPresenceReaderDeps,
  request: LiveAgentSessionPresenceRequest
): Promise<LiveAgentSessionPresenceReading | null> {
  try {
    return await readLiveAgentSessionPresence(deps, {
      subject: {
        agent: request.agent,
        providerSession: request.providerSession,
        worktreeId: request.worktreeId
      },
      // Why: a pane that does not exist yet owns nothing, so no candidate may match it.
      requestingPaneKey: request.paneKey ?? ''
    })
  } catch (err) {
    console.warn('[agent-session] live presence read failed:', err)
    return null
  }
}

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

function isClear(kind: LiveAgentSessionPresenceResponse['kind']): boolean {
  return kind === 'no-live-owner' || kind === 'live-here'
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
  if (!key || effective.kind === 'materializing') {
    // Why: no canonical identity cannot be reserved, and an accepted in-flight
    // collision is an explicit one-shot duplicate that must not displace the holder.
    return { outcome: 'granted', presence: effective }
  }
  const acquired = reservations.tryAcquire(key, request.operationId, ownerId)
  if (acquired === 'granted' || acquired === 'held-by-self') {
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

type IpcSender = { id: number; once: (event: 'destroyed', listener: () => void) => unknown }

export function registerAgentSessionLivePresenceHandlers(
  resolveDeps: () => LiveAgentSessionPresenceReaderDeps,
  resolveReservations: () => LiveSessionMaterializationReservations
): void {
  // Why: no removeHandler first — a second registration must fail loudly, not steal the channel.
  ipcMain.handle(LIVE_AGENT_SESSION_PRESENCE_CHANNEL, (_event, value: unknown) =>
    handleLiveAgentSessionPresenceRequest(resolveDeps(), value)
  )
  const watchedSenders = new Set<number>()
  const ownerOf = (sender: IpcSender): number => {
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
}
