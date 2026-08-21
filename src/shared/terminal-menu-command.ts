/**
 * Terminal actions the application menu can request.
 *
 * Shared rather than owned by the menu because the menu is one invocation surface among several:
 * each command names an action the renderer already performs for a keybinding or a rail control,
 * and the point of naming them here is that all three reach the same one.
 */
export type TerminalMenuCommand =
  | 'newTerminal'
  | 'chooseProfile'
  | 'splitRight'
  | 'splitDown'
  | 'toggleRail'
