import { randomUUID } from 'node:crypto'
import type {
  ReloadPreparationAnswer,
  ReloadPreparationReply
} from '../../shared/reload-preparation-wire'

export const RELOAD_PREPARATION_REQUEST_CHANNEL = 'app:prepareForReload'

/** What main learned before a graceful reload. Only `prepared` may reload. */
export type ReloadPreparationOutcome = 'prepared' | 'refused' | 'timeout' | 'gone'

/** The slice of WebContents this needs; the real one satisfies it. */
export type ReloadPreparationTarget = {
  id: number
  isDestroyed: () => boolean
  send: (channel: string, payload: { requestId: string }) => void
  once: (event: 'destroyed', listener: () => void) => void
  removeListener: (event: 'destroyed', listener: () => void) => void
}

type PendingPreparation = {
  requestId: string
  finish: (outcome: ReloadPreparationOutcome) => void
}

const pendingByWebContentsId = new Map<number, PendingPreparation>()

/**
 * Ask a window's renderer to back up dirty editors and land its durable session checkpoint before
 * main reloads it, the same preparation the renderer's own `app.reload()` performs.
 *
 * Why main asks instead of reloading bare: a dirty editor vetoes an unprepared reload in
 * beforeunload, so the menu reload did nothing, silently, and left the checkpoint unwritten.
 */
export function requestReloadPreparation(
  target: ReloadPreparationTarget,
  { timeoutMs }: { timeoutMs: number }
): Promise<ReloadPreparationOutcome> {
  if (target.isDestroyed()) {
    return Promise.resolve('gone')
  }
  // A newer request for the same window supersedes an older one; the older caller learns nothing
  // was prepared for it.
  pendingByWebContentsId.get(target.id)?.finish('timeout')

  return new Promise<ReloadPreparationOutcome>((resolve) => {
    const requestId = randomUUID()
    const onDestroyed = (): void => finish('gone')
    const timer = setTimeout(() => finish('timeout'), timeoutMs)
    let settled = false
    function finish(outcome: ReloadPreparationOutcome): void {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      target.removeListener('destroyed', onDestroyed)
      if (pendingByWebContentsId.get(target.id)?.requestId === requestId) {
        pendingByWebContentsId.delete(target.id)
      }
      resolve(outcome)
    }
    pendingByWebContentsId.set(target.id, { requestId, finish })
    target.once('destroyed', onDestroyed)
    target.send(RELOAD_PREPARATION_REQUEST_CHANNEL, { requestId })
  })
}

/**
 * The renderer's answer. `proceed` is true only for a prepared answer to the live request of the
 * window that sent it; anything else must release the unload bypass the renderer set while preparing.
 */
export function settleReloadPreparation(
  senderWebContentsId: number,
  answer: ReloadPreparationAnswer
): ReloadPreparationReply {
  const pending = pendingByWebContentsId.get(senderWebContentsId)
  if (!pending || pending.requestId !== answer.requestId) {
    return { proceed: false }
  }
  pending.finish(answer.outcome === 'prepared' ? 'prepared' : 'refused')
  return { proceed: answer.outcome === 'prepared' }
}

export function resetReloadPreparationForTest(): void {
  for (const pending of pendingByWebContentsId.values()) {
    pending.finish('gone')
  }
  pendingByWebContentsId.clear()
}
