import { ipcMain } from 'electron'
import {
  acknowledgePendingTccPromptNotice,
  consumePendingTccPromptNotice,
  dismissTccPromptNotice,
  releasePendingTccPromptNotice
} from '../macos-tcc-prompt-notice'
import { isNativeFileDropPayload, type NativeFileDropPayload } from '../../shared/native-file-drop'
import { isReloadPreparationAnswer } from '../../shared/reload-preparation-wire'
import { takeReloadFreezeFrame } from './reload-freeze-frame'
import { settleReloadPreparation } from './reload-preparation'
import { requestWindowReload } from './window-reload-transaction'

/**
 * The main-window service channels that answer one window, routed to the window that called.
 *
 * These used to be registered per window, each closing over that window's WebContents. Because
 * `ipcMain.handle` throws on a duplicate channel, every registrar removed the channel first — and
 * that removal is what turned a loud failure into a silent transfer. The surviving handler belonged
 * to the newest window and compared its caller against it, so after a second window opened the first
 * one's reload, TCC prompt and file drop returned nothing at all: no error, no log, no rejection.
 * Closing the second window did not give the capability back either, because the guard that stops a
 * stale window removing a live handler cannot re-point one.
 *
 * Registration therefore happens once, and the binding map is the membership test: a sender with no
 * binding is not an attached main window and is dropped rather than answered.
 */

export type WindowServiceHandlers = {
  onBeforeRendererReload?: (args: { webContentsId: number; ignoreCache: boolean }) => void
}

type WindowServiceBinding = WindowServiceHandlers & {
  /** Identifies this window's claim on the app-wide pending TCC notice. */
  tccPromptToken: number
}

const bindingsByWebContentsId = new Map<number, WindowServiceBinding>()
let tccPromptTokenCounter = 0
let registered = false

function bindingFor(event: { sender?: { id?: number } }): WindowServiceBinding | undefined {
  // Why the optional reads: an IPC frame that arrives without an identifiable sender must be
  // dropped, not thrown from — an exception here escapes into Electron's event dispatch.
  const senderId = event?.sender?.id
  return typeof senderId === 'number' ? bindingsByWebContentsId.get(senderId) : undefined
}

function registerOnce(): void {
  if (registered) {
    return
  }
  registered = true

  ipcMain.handle('app:reload', async (event) => {
    const binding = bindingFor(event)
    if (!binding || event.sender.isDestroyed()) {
      return
    }
    // Already prepared by the preload, so it overrides a menu Reload still waiting on main's ask.
    await requestWindowReload(event.sender, {
      kind: 'prepared',
      ...(binding.onBeforeRendererReload ? { onBeforeReload: binding.onBeforeRendererReload } : {})
    })
  })

  // Keyed by the answering document's own id, so one window can never release another's reload.
  ipcMain.handle('app:reloadPreparationSettled', (event, answer: unknown) =>
    isReloadPreparationAnswer(answer)
      ? settleReloadPreparation(event.sender.id, answer)
      : { proceed: false }
  )

  ipcMain.handle('app:takeReloadFreezeFrame', (event) =>
    // Keyed by the asking document's own webContents id, so one window can never take another's.
    takeReloadFreezeFrame(event.sender.id)
  )

  ipcMain.handle('macosTccPrompts:consumePending', (event) => {
    const binding = bindingFor(event)
    return binding ? consumePendingTccPromptNotice(binding.tccPromptToken) : null
  })

  ipcMain.handle('macosTccPrompts:acknowledgePending', (event, claimId: number) => {
    const binding = bindingFor(event)
    if (binding && Number.isSafeInteger(claimId)) {
      acknowledgePendingTccPromptNotice(binding.tccPromptToken, claimId)
    }
  })

  ipcMain.handle('macosTccPrompts:releasePending', (event, claimId: number) => {
    const binding = bindingFor(event)
    if (binding && Number.isSafeInteger(claimId)) {
      releasePendingTccPromptNotice(binding.tccPromptToken, claimId)
    }
  })

  ipcMain.handle('macosTccPrompts:dismiss', (event) => {
    if (bindingFor(event)) {
      dismissTccPromptNotice()
    }
  })

  ipcMain.on(
    'terminal:file-dropped-from-preload',
    (event, args: NativeFileDropPayload) => {
      // Why the drop returns to its sender: a file dropped on a window acts on that window's
      // project, so the destination is the caller and never a window resolved some other way.
      if (!bindingFor(event) || event.sender.isDestroyed() || !isNativeFileDropPayload(args)) {
        return
      }
      event.sender.send('terminal:file-drop', args)
    }
  )
}

export function bindWindowServiceIpc(
  rendererWebContentsId: number,
  handlers: WindowServiceHandlers
): () => void {
  registerOnce()
  const binding: WindowServiceBinding = { ...handlers, tccPromptToken: ++tccPromptTokenCounter }
  releaseTccPromptClaimFor(rendererWebContentsId)
  bindingsByWebContentsId.set(rendererWebContentsId, binding)
  return () => {
    if (bindingsByWebContentsId.get(rendererWebContentsId) === binding) {
      releasePendingTccPromptNotice(binding.tccPromptToken)
      bindingsByWebContentsId.delete(rendererWebContentsId)
    }
  }
}

/**
 * Drop this window's claim on the pending TCC notice without unbinding it — a renderer reload or
 * crash destroys the claim's callbacks while the window itself lives on.
 */
export function releaseTccPromptClaimFor(rendererWebContentsId: number): void {
  const binding = bindingsByWebContentsId.get(rendererWebContentsId)
  if (binding) {
    releasePendingTccPromptNotice(binding.tccPromptToken)
  }
}

export function resetWindowServiceIpcRouterForTest(): void {
  bindingsByWebContentsId.clear()
  tccPromptTokenCounter = 0
  registered = false
}
