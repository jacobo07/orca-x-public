import type { WebContents } from 'electron'
import {
  abandonReloadPreparation,
  requestReloadPreparation,
  type ReloadPreparationOutcome
} from './reload-preparation'
import { reloadWithFreezeFrame, type ReloadRequest } from './reload-with-freeze-frame'
import {
  replaceUnansweringRenderer,
  type ForceReloadReplacementResult
} from './force-reload-replacement'

/** Long enough for a hot-exit backup and a durable checkpoint on a slow disk, short enough to read
 *  as an answer to the click. */
export const GRACEFUL_RELOAD_PREPARE_TIMEOUT_MS = 5_000

/** Force Reload means the user thinks the window is stuck: a renderer that can still prepare does
 *  so well inside this, and one that cannot should not keep them waiting the full Reload bound. */
export const FORCE_RELOAD_PREPARE_TIMEOUT_MS = 1_500

/**
 * `graceful` asks the renderer to prepare first (View > Reload). `prepared` is a renderer that
 * already prepared itself (its own `app.reload()`). `force` also asks, but bypasses the cache and
 * replaces a renderer that refuses or does not answer.
 */
export type WindowReloadKind = 'graceful' | 'prepared' | 'force'

export type WindowReloadResult =
  | 'reloaded'
  | Exclude<ReloadPreparationOutcome, 'prepared'>
  | ForceReloadReplacementResult

type WindowReloadTransaction = ReloadRequest & {
  /** Set once Force joins: an unanswered preparation then ends in replacement, not a notice. */
  forced: boolean
  /** A request that already prepared stops the wait for the renderer's answer. */
  override: () => void
  /** Force starts its own bound on the wait, from the moment it arrives. */
  escalate: () => void
  result: Promise<WindowReloadResult>
}

type PreparationWait = ReloadPreparationOutcome | 'overridden' | 'force-timeout'

const transactionsByWebContentsId = new Map<number, WindowReloadTransaction>()

/**
 * The one reload in flight for a window. A second request joins it rather than starting another,
 * so a double click cannot produce two captures, two reloads, or a false "not reloaded" notice.
 *
 * A `prepared` request overrides a transaction still waiting for the renderer. A `force` request
 * upgrades it to bypass the cache and escalates the wait: past its own short bound, or on a
 * refusal, the window's renderer is replaced (after the user confirms) instead of reloaded in place,
 * because an in-place reload cannot recover a renderer that does not answer.
 */
export function requestWindowReload(
  webContents: WebContents,
  { kind, onBeforeReload }: { kind: WindowReloadKind } & Pick<ReloadRequest, 'onBeforeReload'>
): Promise<WindowReloadResult> {
  const inFlight = transactionsByWebContentsId.get(webContents.id)
  if (inFlight) {
    if (kind !== 'graceful' && onBeforeReload) {
      // The request that decides the reload's shape owns the hook that records it.
      inFlight.onBeforeReload = onBeforeReload
    }
    if (kind === 'force') {
      inFlight.ignoreCache = true
      inFlight.escalate()
    } else if (kind === 'prepared') {
      inFlight.override()
    }
    return inFlight.result
  }
  if (webContents.isDestroyed()) {
    return Promise.resolve('gone')
  }

  let override = (): void => {}
  const overridden = new Promise<'overridden'>((resolve) => {
    override = () => resolve('overridden')
  })
  let deadline: ReturnType<typeof setTimeout> | undefined
  let escalate = (): void => {}
  const forceTimedOut = new Promise<'force-timeout'>((resolve) => {
    escalate = () => {
      if (transaction.forced) {
        return
      }
      transaction.forced = true
      deadline = setTimeout(() => resolve('force-timeout'), FORCE_RELOAD_PREPARE_TIMEOUT_MS)
    }
  })
  const transaction: WindowReloadTransaction = {
    ignoreCache: kind === 'force',
    forced: false,
    onBeforeReload,
    override,
    escalate: () => escalate(),
    result: Promise.resolve<WindowReloadResult>('gone')
  }
  if (kind === 'force') {
    transaction.escalate()
  }
  transactionsByWebContentsId.set(webContents.id, transaction)
  transaction.result = runTransaction(webContents, transaction, kind !== 'prepared', [
    overridden,
    forceTimedOut
  ]).finally(() => clearTimeout(deadline))
  return transaction.result
}

async function runTransaction(
  webContents: WebContents,
  transaction: WindowReloadTransaction,
  prepareFirst: boolean,
  interruptions: Promise<PreparationWait>[]
): Promise<WindowReloadResult> {
  const id = webContents.id
  const end = (result: WindowReloadResult): WindowReloadResult => {
    if (transactionsByWebContentsId.get(id) === transaction) {
      transactionsByWebContentsId.delete(id)
    }
    return result
  }
  try {
    if (prepareFirst) {
      const outcome = await Promise.race<PreparationWait>([
        requestReloadPreparation(webContents, {
          timeoutMs: transaction.forced
            ? FORCE_RELOAD_PREPARE_TIMEOUT_MS
            : GRACEFUL_RELOAD_PREPARE_TIMEOUT_MS
        }),
        ...interruptions
      ])
      if (outcome === 'gone') {
        return end('gone')
      }
      if (outcome !== 'prepared' && outcome !== 'overridden') {
        if (!transaction.forced) {
          return end(outcome === 'force-timeout' ? 'timeout' : outcome)
        }
        // Stop waiting first: a late `prepared` must not be told a reload is coming.
        abandonReloadPreparation(id)
        return end(await replaceUnansweringRenderer(webContents))
      }
    }
    // The transaction itself is the request: an override arriving during the capture still decides
    // the cache mode and the hook, because both are read after the capture's await.
    await reloadWithFreezeFrame(webContents, transaction)
    return end(webContents.isDestroyed() ? 'gone' : 'reloaded')
  } catch (error) {
    end('gone')
    throw error
  }
}

export function resetWindowReloadTransactionsForTest(): void {
  transactionsByWebContentsId.clear()
}
