/**
 * What to do with the answer to the "Orca keeps failing to load" prompt.
 *
 * The prompt offers Reload or Quit, and the caller used to act only when Reload was chosen *and* a
 * live window was still there to reload. The unwritten third case — Reload chosen with the window
 * already gone — fell out of the bottom and did nothing: no reload, no quit, and a main process left
 * running with no window, no renderer and no tray behind it.
 *
 * That state is not recoverable from the outside. It answers no shortcut, shows nothing to click,
 * and survives until someone finds it in a task manager — including, in the case that produced this
 * module, an installer that asks the user to "close the application manually" when there is nothing
 * to close.
 *
 * So the rule is total: every answer maps to an action, and the action when there is nothing left to
 * reload is to quit. Quitting loses nothing a reload would have kept — the window is already gone.
 */
export type RendererRecoveryPromptAction = 'reload' | 'quit'

export const RENDERER_RECOVERY_PROMPT_RELOAD_RESPONSE = 0
export const RENDERER_RECOVERY_PROMPT_QUIT_RESPONSE = 1

export function resolveRendererRecoveryPromptAction(input: {
  /** Index of the pressed button; the dialog's cancelId maps a dismissal onto Quit. */
  response: number
  /** Whether a window still exists to reload into. */
  hasLiveWindow: boolean
}): RendererRecoveryPromptAction {
  if (input.response === RENDERER_RECOVERY_PROMPT_RELOAD_RESPONSE && input.hasLiveWindow) {
    return 'reload'
  }
  // Everything else quits, including an unexpected response index: a prompt whose answer we cannot
  // interpret must still leave the app in a state the user can act on.
  return 'quit'
}
