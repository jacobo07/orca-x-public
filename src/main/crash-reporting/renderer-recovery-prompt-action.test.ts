/**
 * The recovery prompt must not be able to leave the app running with nothing on screen.
 *
 * The third case is the one that matters and the one nobody wrote: Reload chosen after the window
 * has already gone. It used to fall past both branches and do nothing, leaving a main process with
 * no window, no renderer and no tray — invisible, unclosable, and still holding the app's name
 * against an installer that asks the user to close it.
 */
import { describe, expect, it } from 'vitest'
import {
  RENDERER_RECOVERY_PROMPT_QUIT_RESPONSE,
  RENDERER_RECOVERY_PROMPT_RELOAD_RESPONSE,
  resolveRendererRecoveryPromptAction
} from './renderer-recovery-prompt-action'

describe('resolveRendererRecoveryPromptAction', () => {
  it('reloads when the user asks to and there is a window to reload', () => {
    expect(
      resolveRendererRecoveryPromptAction({
        response: RENDERER_RECOVERY_PROMPT_RELOAD_RESPONSE,
        hasLiveWindow: true
      })
    ).toBe('reload')
  })

  it('quits when the user asks to quit', () => {
    expect(
      resolveRendererRecoveryPromptAction({
        response: RENDERER_RECOVERY_PROMPT_QUIT_RESPONSE,
        hasLiveWindow: true
      })
    ).toBe('quit')
  })

  it('quits when reload is chosen but the window is already gone', () => {
    // The husk case. Doing nothing here is worse than quitting: quitting loses nothing a reload
    // would have kept, because there is no longer a window to reload into.
    expect(
      resolveRendererRecoveryPromptAction({
        response: RENDERER_RECOVERY_PROMPT_RELOAD_RESPONSE,
        hasLiveWindow: false
      })
    ).toBe('quit')
  })

  it('quits on a response index it does not recognise', () => {
    // A dialog that returns something unexpected must still leave the user something to act on.
    expect(resolveRendererRecoveryPromptAction({ response: 7, hasLiveWindow: true })).toBe('quit')
    expect(resolveRendererRecoveryPromptAction({ response: -1, hasLiveWindow: false })).toBe('quit')
  })
})
