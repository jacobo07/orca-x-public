import { DaemonClient } from './client'
import { PROTOCOL_VERSION, type ListSessionsResult } from './types'

/**
 * How many sessions the daemon says are alive, or null when it could not be asked.
 *
 * Lives here rather than beside its first caller because the same question has to be asked
 * twice: once to decide a daemon may be replaced, and again at the destructive effect itself.
 * Two copies of it would be correct on the day they were written and would drift afterwards.
 *
 * null is load-bearing and is NOT zero: a daemon too wedged to answer may still own live
 * sessions. Callers decide what unknown licenses; this only reports what was observed.
 */
export async function getAliveDaemonSessionCount(
  socketPath: string,
  tokenPath: string,
  protocolVersion = PROTOCOL_VERSION
): Promise<number | null> {
  const client = new DaemonClient({ socketPath, tokenPath, protocolVersion })
  try {
    await client.ensureConnected()
    const result = await client.request<ListSessionsResult>('listSessions', undefined)
    return result.sessions.filter((session) => session.isAlive).length
  } catch {
    return null
  } finally {
    client.disconnect()
  }
}
