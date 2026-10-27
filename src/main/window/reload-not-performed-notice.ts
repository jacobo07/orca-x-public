import { BrowserWindow, dialog, webContents as webContentsModule } from 'electron'
import { translateMain } from '../i18n/main-i18n'

export type ReloadNotPerformedOutcome = 'refused' | 'timeout'

/** Why two texts: a refusal came from a live window that protected its work; a timeout came from
 *  one that may be hung, and only the second has somewhere else to go (Force Reload). */
export function describeReloadNotPerformed(outcome: ReloadNotPerformedOutcome): {
  message: string
  detail: string
} {
  if (outcome === 'refused') {
    return {
      message: translateMain('menu.reloadRefusedTitle', 'This window was not reloaded'),
      detail: translateMain(
        'menu.reloadRefusedDetail',
        "Orca could not save this window's unsaved edits and session first, so it left the window as it was. Your work is still open in it."
      )
    }
  }
  return {
    message: translateMain('menu.reloadNotRespondingTitle', 'This window did not respond to Reload'),
    detail: translateMain(
      'menu.reloadNotRespondingDetail',
      'Nothing was reloaded. If the window stays unresponsive, use View > Force Reload.'
    )
  }
}

export function showReloadNotPerformedNotice(args: {
  outcome: ReloadNotPerformedOutcome
  webContentsId: number
}): void {
  const target = webContentsModule.fromId(args.webContentsId)
  const window = target && !target.isDestroyed() ? BrowserWindow.fromWebContents(target) : null
  const options: Electron.MessageBoxOptions = {
    type: args.outcome === 'refused' ? 'info' : 'warning',
    ...describeReloadNotPerformed(args.outcome)
  }
  void (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options)).catch(
    () => {
      // Best-effort: the window may close while the notice is opening.
    }
  )
}
