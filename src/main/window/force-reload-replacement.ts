import { BrowserWindow, dialog, type WebContents } from 'electron'
import { translateMain } from '../i18n/main-i18n'
import { replaceWindowRenderer, type RendererReplacementResult } from './renderer-replacement'

/** `shared-renderer`: another window lives in the same process, so crashing it would kill that one too. */
export type ForceReloadReplacementResult =
  | RendererReplacementResult
  | 'unsupported'
  | 'cancelled'
  | 'shared-renderer'

type ReplacementTarget = Pick<WebContents, 'id' | 'isDestroyed' | 'getOSProcessId'>

export type ForceReloadReplacementDeps = {
  confirm: (webContents: ReplacementTarget) => Promise<boolean>
  sharesRendererProcess: (webContents: ReplacementTarget) => boolean
  notifySharedRenderer: (webContents: ReplacementTarget) => void
  replace: (webContentsId: number) => Promise<RendererReplacementResult | 'unsupported'>
}

/** Electron's docs warn `forcefullyCrashRenderer()` kills every page sharing the process. */
export function sharesRendererProcess(webContents: ReplacementTarget): boolean {
  const pid = webContents.getOSProcessId()
  if (!pid) {
    return false
  }
  return BrowserWindow.getAllWindows().some(
    (window) =>
      !window.isDestroyed() &&
      window.webContents.id !== webContents.id &&
      window.webContents.getOSProcessId() === pid
  )
}

function parentWindowOf(webContents: ReplacementTarget): BrowserWindow | null {
  return webContents.isDestroyed() ? null : BrowserWindow.fromWebContents(webContents as WebContents)
}

/** Cancel is the default and the escape answer: replacing discards what the renderer did not save. */
export async function confirmRendererReplacement(webContents: ReplacementTarget): Promise<boolean> {
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    buttons: [
      translateMain('menu.forceReloadReplaceCancel', 'Cancel'),
      translateMain('menu.forceReloadReplaceConfirm', 'Restart Window')
    ],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: translateMain('menu.forceReloadReplaceTitle', 'This window is not responding'),
    detail: translateMain(
      'menu.forceReloadReplaceDetail',
      'Orca can restart this window, but unsaved edits in this window may be lost. Other windows and running terminals are not affected.'
    )
  }
  const window = parentWindowOf(webContents)
  try {
    const { response } = await (window
      ? dialog.showMessageBox(window, options)
      : dialog.showMessageBox(options))
    return response === 1
  } catch {
    return false
  }
}

export function showSharedRendererNotice(webContents: ReplacementTarget): void {
  const options: Electron.MessageBoxOptions = {
    type: 'info',
    message: translateMain('menu.forceReloadSharedTitle', 'This window was not restarted'),
    detail: translateMain(
      'menu.forceReloadSharedDetail',
      'It shares its process with another Orca window, and restarting it would close that window too. Nothing was changed.'
    )
  }
  const window = parentWindowOf(webContents)
  void (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options)).catch(
    () => {
      // Best-effort: the window may close while the notice is opening.
    }
  )
}

const electronDeps: ForceReloadReplacementDeps = {
  confirm: confirmRendererReplacement,
  sharesRendererProcess,
  notifySharedRenderer: showSharedRendererNotice,
  replace: replaceWindowRenderer
}

/**
 * Force Reload for a renderer that refused or did not answer preparation: a same-process reload
 * cannot help it, so the user is asked, then the window's own replacer starts a new process.
 */
export async function replaceUnansweringRenderer(
  webContents: ReplacementTarget,
  deps: ForceReloadReplacementDeps = electronDeps
): Promise<ForceReloadReplacementResult> {
  if (webContents.isDestroyed()) {
    return 'gone'
  }
  if (deps.sharesRendererProcess(webContents)) {
    deps.notifySharedRenderer(webContents)
    return 'shared-renderer'
  }
  if (!(await deps.confirm(webContents))) {
    return 'cancelled'
  }
  if (webContents.isDestroyed()) {
    return 'gone'
  }
  // Re-checked: a window opened while the confirm was up can have joined the process.
  if (deps.sharesRendererProcess(webContents)) {
    deps.notifySharedRenderer(webContents)
    return 'shared-renderer'
  }
  return deps.replace(webContents.id)
}
