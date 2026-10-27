import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  getRemoteRuntimePtyEnvironmentId,
  getRemoteRuntimeTerminalHandle
} from '@/runtime/runtime-terminal-stream'

type PhoneLeaseSettings = Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | undefined
type PhoneLeaseAnswer = { reclaimed: boolean; retryAfterMs?: number }

// Why: an older host (no such method) or a failed ask must not turn every dropped keystroke into a request.
const FAILURE_BACKOFF_MS = 30_000
const REQUEST_TIMEOUT_MS = 5_000

const inFlightPtyIds = new Set<string>()
const notBeforeByPtyId = new Map<string, number>()

const notReclaimed = (): PhoneLeaseAnswer => ({ reclaimed: false })

async function requestPhoneLeaseReclaim(
  ptyId: string,
  settings: PhoneLeaseSettings
): Promise<PhoneLeaseAnswer> {
  const remoteHandle = getRemoteRuntimeTerminalHandle(ptyId)
  const environmentId =
    getRemoteRuntimePtyEnvironmentId(ptyId) ?? settings?.activeRuntimeEnvironmentId ?? null
  const pending =
    remoteHandle && environmentId
      ? callRuntimeRpc<PhoneLeaseAnswer>(
          { kind: 'environment', environmentId },
          'terminal.reclaimIfPhoneIdle',
          { terminal: remoteHandle },
          { timeoutMs: REQUEST_TIMEOUT_MS }
        )
      : window.api.runtime.reclaimTerminalIfPhoneIdle(ptyId)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<PhoneLeaseAnswer>((resolve) => {
    timer = setTimeout(() => resolve(notReclaimed()), REQUEST_TIMEOUT_MS)
  })
  try {
    return await Promise.race([pending.catch(notReclaimed), timedOut])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Asks the host to end an expired phone lease after a desktop keystroke was dropped. Returns null
 * when no request was sent: one is already in flight, or the host said to wait.
 */
export function askToReclaimTerminalIfPhoneIdle(
  ptyId: string,
  settings: PhoneLeaseSettings,
  now: number = Date.now()
): Promise<boolean> | null {
  if (inFlightPtyIds.has(ptyId) || (notBeforeByPtyId.get(ptyId) ?? 0) > now) {
    return null
  }
  inFlightPtyIds.add(ptyId)
  return requestPhoneLeaseReclaim(ptyId, settings)
    .catch(notReclaimed)
    .then((answer) => {
      if (answer.reclaimed) {
        notBeforeByPtyId.delete(ptyId)
      } else {
        notBeforeByPtyId.set(ptyId, Date.now() + (answer.retryAfterMs ?? FAILURE_BACKOFF_MS))
      }
      return answer.reclaimed
    })
    .finally(() => {
      inFlightPtyIds.delete(ptyId)
    })
}

export function resetPhoneLeaseReclaimForTests(): void {
  inFlightPtyIds.clear()
  notBeforeByPtyId.clear()
}
