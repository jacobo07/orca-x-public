import type { WebContents } from 'electron'
import { requestReloadPreparation, type ReloadPreparationOutcome } from './reload-preparation'
import { reloadWithFreezeFrame, type ReloadRequest } from './reload-with-freeze-frame'

/** Long enough for a hot-exit backup and a durable checkpoint on a slow disk, short enough to read
 *  as an answer to the click. */
export const GRACEFUL_RELOAD_PREPARE_TIMEOUT_MS = 5_000

export type GracefulReloadResult = 'reloaded' | Exclude<ReloadPreparationOutcome, 'prepared'>

/**
 * Reload Window: prepare first, reload only a prepared window.
 *
 * `refused` and `timeout` leave the window exactly as it was — nothing unsaved is at risk — and the
 * caller owes the user a message, because a reload that silently does nothing reads as a dead menu.
 */
export async function reloadWindowGracefully(
  webContents: WebContents,
  request: Omit<ReloadRequest, 'ignoreCache'>
): Promise<GracefulReloadResult> {
  const outcome = await requestReloadPreparation(webContents, {
    timeoutMs: GRACEFUL_RELOAD_PREPARE_TIMEOUT_MS
  })
  if (outcome !== 'prepared') {
    return outcome
  }
  if (webContents.isDestroyed()) {
    return 'gone'
  }
  await reloadWithFreezeFrame(webContents, { ...request, ignoreCache: false })
  return 'reloaded'
}
