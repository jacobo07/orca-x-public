import { randomUUID } from 'node:crypto'
import {
  parseLiveAgentSessionPresenceRequest,
  type LiveSessionResumeRefusal
} from '../../shared/live-agent-session-presence-types'
import { makePaneKey, parsePaneKey } from '../../shared/stable-pane-id'
import type { LiveAgentSessionPresenceReaderDeps } from '../agent-hooks/live-agent-session-presence-reader'
import type { LiveSessionMaterializationReservations } from '../agent-hooks/live-session-materialization-reservation'
import type { ResumeSpawnDecision, ResumeSpawnRequest } from '../agent-hooks/resume-spawn-gate-slot'
import {
  isClearPresence,
  readPresence,
  toPresenceResponse
} from './live-agent-session-presence-response'

const refused = (reason: LiveSessionResumeRefusal): ResumeSpawnDecision => ({
  outcome: 'refused',
  reason
})

/** Decides, at the spawn, whether a pane may resume an existing provider session. Every
 *  Orca-selected resume reaches here whatever its reason (AI Vault, sleep, cold restore,
 *  working set), so the reason never enters the key. Automatic spawns get no override:
 *  only a permit an explicit Continue recorded for this tab lets a collision through. */
export async function decideResumeSpawn(
  deps: LiveAgentSessionPresenceReaderDeps,
  reservations: LiveSessionMaterializationReservations,
  request: Omit<ResumeSpawnRequest, 'sender'> & { ownerId: number },
  mintOperationId: () => string = randomUUID
): Promise<ResumeSpawnDecision> {
  const paneKey = makePaneKey(request.tabId, request.leafId)
  const subject = parseLiveAgentSessionPresenceRequest({
    ...(parsePaneKey(paneKey) ? { paneKey } : {}),
    worktreeId: request.worktreeId,
    agent: request.agent,
    providerSession: request.providerSession
  })
  const claimed = request.expectedKey !== undefined
  if (!subject) {
    // Why: without an exact resumable session there is no resume to collide with.
    return claimed ? refused('unknown') : { outcome: 'proceed', operationId: null }
  }
  const reading = await readPresence(deps, subject)
  if (!reading) {
    return refused('unknown')
  }
  const key = reading.subjectKey
  if (claimed && key !== request.expectedKey) {
    // Why: a signed claim this host cannot reproduce names a session presence cannot see.
    return refused('unknown')
  }
  if (!key) {
    // Why: a host that cannot place the identity (SSH) proceeds unreserved, as before.
    return { outcome: 'proceed', operationId: null }
  }
  // Nothing below awaits: the reservation state read here is the state written here.
  for (const livePaneKey of reading.liveElsewhere) {
    const liveTabId = parsePaneKey(livePaneKey)?.tabId
    if (liveTabId && liveTabId !== request.tabId) {
      reservations.releaseForTab(liveTabId)
    }
  }
  if (reservations.consumePermit(key, request.tabId)) {
    return { outcome: 'proceed', operationId: null }
  }
  const holder = reservations.holder(key)
  if (holder?.tabId === request.tabId) {
    // Why: the operation that reserved this session materializes into this tab.
    return { outcome: 'proceed', operationId: null }
  }
  const presence = toPresenceResponse(reading)
  if (!isClearPresence(presence.kind)) {
    return refused(
      presence.kind === 'live-elsewhere' || presence.kind === 'multiple-live-owners'
        ? presence.kind
        : 'unknown'
    )
  }
  if (holder) {
    return refused('materializing')
  }
  const operationId = mintOperationId()
  const acquired = reservations.tryAcquire(key, operationId, request.ownerId)
  if (acquired !== 'granted') {
    return refused(acquired === 'contended' ? 'materializing' : 'unknown')
  }
  reservations.attachTab(operationId, request.ownerId, request.tabId)
  return { outcome: 'proceed', operationId }
}
