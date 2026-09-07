import type { TerminalMenuCommand } from '../../shared/terminal-menu-command'
import type { KeybindingActionId } from '../../shared/keybindings'
import { translateMain } from '../i18n/main-i18n'

/**
 * The Terminal application menu.
 *
 * Its own module because register-app-menu.ts is at the max-lines ceiling, and because the menu is
 * one invocation surface for actions the renderer owns -- it carries no terminal logic, only the
 * names of commands the renderer already performs for a keybinding or a rail control.
 */
export function buildTerminalMenu({
  onTerminalCommand,
  shortcutLabel
}: {
  // Why the window travels with the command: these act on the renderer that owns the menu, and main
  // cannot recover which one that was after the fact — see register-app-menu.ts for the reference
  // that used to be guessed here.
  onTerminalCommand: (
    command: TerminalMenuCommand,
    window?: Electron.BaseWindow | null
  ) => void
  shortcutLabel: (action: KeybindingActionId) => string
}): Electron.MenuItemConstructorOptions {
  return {
    label: translateMain('menu.terminal', 'Terminal'),
    submenu: [
      {
        label: `${translateMain('menu.newTerminal', 'New Terminal')}\t${shortcutLabel('tab.newTerminal')}`,
        click: (_menuItem, window) => onTerminalCommand('newTerminal', window)
      },
      {
        label: `${translateMain('menu.chooseTerminalProfile', 'New Terminal With Profile...')}\t${shortcutLabel('terminal.chooseProfile')}`,
        click: (_menuItem, window) => onTerminalCommand('chooseProfile', window)
      },
      { type: 'separator' },
      {
        label: `${translateMain('menu.splitTerminalRight', 'Split Terminal Right')}\t${shortcutLabel('terminal.splitRight')}`,
        click: (_menuItem, window) => onTerminalCommand('splitRight', window)
      },
      {
        label: `${translateMain('menu.splitTerminalDown', 'Split Terminal Down')}\t${shortcutLabel('terminal.splitDown')}`,
        click: (_menuItem, window) => onTerminalCommand('splitDown', window)
      },
      { type: 'separator' },
      {
        label: translateMain('menu.toggleTerminalRail', 'Toggle Terminal Rail'),
        click: (_menuItem, window) => onTerminalCommand('toggleRail', window)
      }
    ]
  }
}
