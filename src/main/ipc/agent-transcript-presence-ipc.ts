import { ipcMain } from 'electron'
import {
  AGENT_TRANSCRIPT_PRESENCE_CHANNEL,
  parseAgentTranscriptPresenceRequest
} from '../../shared/agent-transcript-presence-request'
import type { WorkingSetFactPresence } from '../../shared/project-working-set-store-types'
import {
  boundedTranscriptPresence,
  probeAgentTranscriptPresence,
  type AgentTranscriptPresenceDeps
} from '../native-chat/agent-transcript-presence'

/** Why bounded: a caller asks this on the way into a destructive transition, so a stalled mount
 *  must cost a timeout and an honest `unknown`, never a workspace that will not go to sleep. */
const PROBE_TIMEOUT_MS = 2_000

export async function handleAgentTranscriptPresenceRequest(
  value: unknown,
  deps?: AgentTranscriptPresenceDeps,
  timeoutMs: number = PROBE_TIMEOUT_MS
): Promise<WorkingSetFactPresence> {
  const request = parseAgentTranscriptPresenceRequest(value)
  // A request nobody could read says nothing about the transcript. It is not evidence of deletion.
  if (!request) {
    return 'unknown'
  }
  return boundedTranscriptPresence(() => probeAgentTranscriptPresence(request, deps), timeoutMs)
}

export function registerAgentTranscriptPresenceHandler(): void {
  // Why no removeHandler first: a second registration must fail loudly, not steal the channel.
  ipcMain.handle(AGENT_TRANSCRIPT_PRESENCE_CHANNEL, (_event, value: unknown) =>
    handleAgentTranscriptPresenceRequest(value)
  )
}
