import type { WebContents } from 'electron'
import { requestReloadPreparation, type ReloadPreparationOutcome } from './reload-preparation'
import { reloadWithFreezeFrame, type ReloadRequest } from './reload-with-freeze-frame'

/** Long enough for a hot-exit backup and a durable checkpoint on a slow disk, short enough to read
 *  as an answer to the click. */
export const GRACEFUL_RELOAD_PREPARE_TIMEOUT_MS = 5_000

/**
 * `graceful` asks the renderer to prepare first (View > Reload). `prepared` is a renderer that
 * already prepared itself (its own `app.reload()`). `force` bypasses the cache without asking.
 */
export type WindowReloadKind = 'graceful' | 'prepared' | 'force'

export type WindowReloadResult = 'reloaded' | Exclude<ReloadPreparationOutcome, 'prepared'>

type WindowReloadTransaction = ReloadRequest & {
  /** Resolves when a request that does not need the preparation overrides the wait for it. */
  override: () => void
  result: Promise<WindowReloadResult>
}

const transactionsByWebContentsId = new Map<number, WindowReloadTransaction>()

/**
 * The one reload in flight for a window. A second request joins it rather than starting another,
 * so a double click cannot produce two captures, two reloads, or a false "not reloaded" notice.
 *
 * A request that does not need the renderer's preparation (`force`, `prepared`) overrides a
 * transaction still waiting for one; `force` also upgrades the reload to bypass the cache. The
 * overridden preparation stays open, so its late `prepared` answer is told to proceed — a reload is
 * coming, and the renderer's unload bypass is shared with its own `app.reload()`.
 */
export function requestWindowReload(
  webContents: WebContents,
  { kind, onBeforeReload }: { kind: WindowReloadKind } & Pick<ReloadRequest, 'onBeforeReload'>
): Promise<WindowReloadResult> {
  const inFlight = transactionsByWebContentsId.get(webContents.id)
  if (inFlight) {
    if (kind !== 'graceful') {
      if (kind === 'force') {
        inFlight.ignoreCache = true
      }
      // The request that decides the reload's shape owns the hook that records it.
      if (onBeforeReload) {
        inFlight.onBeforeReload = onBeforeReload
      }
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
  const transaction: WindowReloadTransaction = {
    ignoreCache: kind === 'force',
    onBeforeReload,
    override,
    result: Promise.resolve<WindowReloadResult>('gone')
  }
  transactionsByWebContentsId.set(webContents.id, transaction)
  transaction.result = runTransaction(webContents, transaction, kind === 'graceful', overridden)
  return transaction.result
}

async function runTransaction(
  webContents: WebContents,
  transaction: WindowReloadTransaction,
  prepareFirst: boolean,
  overridden: Promise<'overridden'>
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
      const outcome = await Promise.race([
        requestReloadPreparation(webContents, { timeoutMs: GRACEFUL_RELOAD_PREPARE_TIMEOUT_MS }),
        overridden
      ])
      if (outcome !== 'prepared' && outcome !== 'overridden') {
        return end(outcome)
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
