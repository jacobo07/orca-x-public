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
  onTerminalCommand: (command: TerminalMenuCommand) => void
  shortcutLabel: (action: KeybindingActionId) => string
}): Electron.MenuItemConstructorOptions {
  return {
    label: translateMain('menu.terminal', 'Terminal'),
    submenu: [
      {
        label: `${translateMain('menu.newTerminal', 'New Terminal')}\t${shortcutLabel('tab.newTerminal')}`,
        click: () => onTerminalCommand('newTerminal')
      },
      {
        label: `${translateMain('menu.chooseTerminalProfile', 'New Terminal With Profile...')}\t${shortcutLabel('terminal.chooseProfile')}`,
        click: () => onTerminalCommand('chooseProfile')
      },
      { type: 'separator' },
      {
        label: `${translateMain('menu.splitTerminalRight', 'Split Terminal Right')}\t${shortcutLabel('terminal.splitRight')}`,
        click: () => onTerminalCommand('splitRight')
      },
      {
        label: `${translateMain('menu.splitTerminalDown', 'Split Terminal Down')}\t${shortcutLabel('terminal.splitDown')}`,
        click: () => onTerminalCommand('splitDown')
      },
      { type: 'separator' },
      {
        label: translateMain('menu.toggleTerminalRail', 'Toggle Terminal Rail'),
        click: () => onTerminalCommand('toggleRail')
      }
    ]
  }
}
