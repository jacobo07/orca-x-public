import type { KeybindingActionId } from '../../shared/keybindings'
import type { AppearanceMenuKey, AppearanceMenuState } from './register-app-menu'
import { translateMain } from '../i18n/main-i18n'

/**
 * Why: mirror VS Code's View > Appearance submenu so users can toggle
 * sidebar/status-bar/tasks-button/titlebar-activity from the menu bar as
 * well as from the settings pane. Electron doesn't reactively update
 * menu items when the backing state changes, so rebuildAppMenu() must be
 * called after every settings update — each build reads current
 * appearance state through getAppearanceState() and produces a fresh
 * template with accurate `checked` values.
 */
export function buildAppearanceSubmenu({
  appearance,
  onToggleAppearance,
  onToggleLeftSidebar,
  onToggleRightSidebar,
  shortcutLabel
}: {
  appearance: AppearanceMenuState
  onToggleAppearance: (key: AppearanceMenuKey) => void
  onToggleLeftSidebar: () => void
  onToggleRightSidebar: () => void
  shortcutLabel: (action: KeybindingActionId) => string
}): Electron.MenuItemConstructorOptions {
  return {
    label: translateMain('menu.appearance', 'Appearance'),
    submenu: [
      {
        // Why: display-only shortcut hint — not a real accelerator. Cmd/Ctrl+B
        // is intercepted in createMainWindow.ts's before-input-event handler
        // with a TipTap-bold carve-out for markdown editors. Binding the
        // accelerator here would steal the chord before that carve-out can
        // fire. Sidebar open/closed lives in the renderer store (non-persisted),
        // so we forward a toggle request rather than mirroring state in main.
        label: `${translateMain('menu.toggleLeftSidebar', 'Toggle Left Sidebar')}\t${shortcutLabel('sidebar.left.toggle')}`,
        click: () => onToggleLeftSidebar()
      },
      {
        // Why: display-only shortcut hint for the same reason as above.
        label: `${translateMain('menu.toggleRightSidebar', 'Toggle Right Sidebar')}\t${shortcutLabel('sidebar.right.toggle')}`,
        click: () => onToggleRightSidebar()
      },
      {
        label: translateMain('menu.showStatusBar', 'Show Status Bar'),
        type: 'checkbox',
        checked: appearance.statusBarVisible,
        click: () => onToggleAppearance('statusBarVisible')
      },
      { type: 'separator' },
      {
        label: translateMain('menu.showTasksButton', 'Show Tasks Button'),
        type: 'checkbox',
        checked: appearance.showTasksButton,
        click: () => onToggleAppearance('showTasksButton')
      },
      {
        label: translateMain('menu.showAutomationsButton', 'Show Automations Button'),
        type: 'checkbox',
        checked: appearance.showAutomationsButton,
        click: () => onToggleAppearance('showAutomationsButton')
      },
      {
        label: translateMain('menu.showMobileButton', 'Show Orca Mobile Button'),
        type: 'checkbox',
        checked: appearance.showMobileButton,
        click: () => onToggleAppearance('showMobileButton')
      },
      {
        label: translateMain('menu.showWorkspaceButton', 'Show Workspace Button'),
        type: 'checkbox',
        checked: appearance.showWorkspaceButton,
        click: () => onToggleAppearance('showWorkspaceButton')
      },
      {
        label: translateMain('menu.showTitlebarAppName', 'Show Titlebar App Name'),
        type: 'checkbox',
        checked: appearance.showTitlebarAppName,
        click: () => onToggleAppearance('showTitlebarAppName')
      }
    ]
  }
}
