import { BrowserWindow, Menu, app } from 'electron'
import {
  formatKeybindingList,
  getEffectiveKeybindingsForAction,
  type KeybindingActionId,
  type KeybindingOverrides
} from '../../shared/keybindings'
import type { TerminalMenuCommand } from '../../shared/terminal-menu-command'
import type { UpdateCheckOptions } from '../../shared/update-status-types'
import { translateMain } from '../i18n/main-i18n'
import { requestParkFromMenu } from '../durable-exit/park-menu-command'
import { reloadWithFreezeFrame } from '../window/reload-with-freeze-frame'
import { createAppMenuSelectionItem } from './app-menu-selection-item'
import { buildAppearanceSubmenu } from './appearance-menu'
import { buildTerminalMenu } from './terminal-menu'

export type AppearanceMenuState = {
  showTasksButton: boolean
  showAutomationsButton: boolean
  showMobileButton: boolean
  showWorkspaceButton: boolean
  showTitlebarAppName: boolean
  statusBarVisible: boolean
}

export type AppearanceMenuKey = keyof AppearanceMenuState

export function getNextDefaultOnAppearanceSettingValue(current: boolean | undefined): boolean {
  return !(current !== false)
}

type RegisterAppMenuOptions = {
  /** Open another project window. */
  onOpenNewWindow: () => void
  onOpenSettings: () => void
  onOpenSetupGuide: (window?: Electron.BaseWindow | null) => void
  onOpenFeatureTour: (window?: Electron.BaseWindow | null) => void
  onOpenCrashReport: (window?: Electron.BaseWindow | null) => void
  onCheckForUpdates: (options: UpdateCheckOptions) => void
  onBeforeReload?: (options: { ignoreCache: boolean; webContentsId: number }) => void
  // Why each of these takes the invoking window: Electron hands every click the window whose menu
  // ran it, and a handler that drops it has to guess. The guess in main was a module-level reference
  // assigned on window creation, so with two windows open a command invoked from the older one acted
  // on the newer one. Same shape as onOpenSetupGuide/onOpenFeatureTour above, which already do this.
  onZoomIn: (window?: Electron.BaseWindow | null) => void
  onZoomOut: (window?: Electron.BaseWindow | null) => void
  onZoomReset: (window?: Electron.BaseWindow | null) => void
  onToggleLeftSidebar: (window?: Electron.BaseWindow | null) => void
  onToggleRightSidebar: (window?: Electron.BaseWindow | null) => void
  onTerminalCommand: (command: TerminalMenuCommand, window?: Electron.BaseWindow | null) => void
  onToggleAppearance: (key: AppearanceMenuKey) => void
  getAppearanceState: () => AppearanceMenuState
  getKeybindings?: () => KeybindingOverrides | undefined
  // Why: the macOS app-menu title. Passed the per-branch dev label since
  // app.name is now pinned to a stable value for Keychain-key stability.
  appMenuLabel?: string
}

function buildAndApplyMenu(options: RegisterAppMenuOptions): void {
  const {
    onOpenNewWindow,
    onOpenSettings,
    onOpenSetupGuide,
    onOpenFeatureTour,
    onOpenCrashReport,
    onCheckForUpdates,
    onBeforeReload,
    onZoomIn,
    onZoomOut,
    onZoomReset,
    onTerminalCommand,
    onToggleLeftSidebar,
    onToggleRightSidebar,
    onToggleAppearance,
    getAppearanceState,
    getKeybindings
  } = options

  const isMac = process.platform === 'darwin'
  const appearance = getAppearanceState()
  const shortcutLabel = (actionId: KeybindingActionId): string => {
    const bindings = getEffectiveKeybindingsForAction(
      actionId,
      process.platform,
      getKeybindings?.()
    )
    return formatKeybindingList(bindings, process.platform)
  }

  const reloadFocusedWindow = (ignoreCache: boolean): void => {
    const webContents = BrowserWindow.getFocusedWindow()?.webContents
    if (!webContents) {
      return
    }

    // Routed through the shared authority so the menu, the accelerator and the renderer's own
    // `app:reload` all capture the freeze frame; a menu-local reload would flash.
    void reloadWithFreezeFrame(webContents, { ignoreCache, onBeforeReload })
  }

  // Why: modifier-click update checks are hidden power-user affordances.
  // Extracted so the macOS app-menu entry and Windows/Linux Help entry share
  // identical RC/perf channel routing.
  const checkForUpdatesClick: Electron.MenuItemConstructorOptions['click'] = (
    _menuItem,
    _window,
    event
  ) => {
    const modifierClick = !event.triggeredByAccelerator
    const localBuild = isMac && modifierClick && event.altKey === true
    const includePerfPrerelease =
      !localBuild && modifierClick && (isMac ? event.metaKey === true : event.ctrlKey === true)
    const includePrerelease = !localBuild && modifierClick && event.shiftKey === true
    onCheckForUpdates({
      includePrerelease,
      includePerfPrerelease,
      ...(localBuild ? { localBuild: true } : {})
    })
  }

  const checkForUpdatesItem: Electron.MenuItemConstructorOptions = {
    label: translateMain('menu.checkForUpdates', 'Check for Updates...'),
    click: checkForUpdatesClick
  }

  const settingsItem: Electron.MenuItemConstructorOptions = {
    label: `${translateMain('menu.settings', 'Settings')}\t${shortcutLabel('app.settings')}`,
    click: () => onOpenSettings()
  }

  const featureTourItem: Electron.MenuItemConstructorOptions = {
    label: translateMain('menu.exploreOrca', 'Explore Orca'),
    click: (_menuItem, window) => onOpenFeatureTour(window)
  }

  const setupGuideItem: Electron.MenuItemConstructorOptions = {
    label: translateMain('menu.gettingStarted', 'Getting Started with Orca'),
    click: (_menuItem, window) => onOpenSetupGuide(window)
  }

  const crashReportItem: Electron.MenuItemConstructorOptions = {
    label: translateMain('menu.reportCrash', 'Report Crash...'),
    click: (_menuItem, window) => onOpenCrashReport(window)
  }

  // Why: the macOS app-menu (named after the app) is mandatory on darwin and
  // owns hide/hideOthers/unhide/services/quit roles that only make sense in
  // the system menu bar. On Windows/Linux that menu would render as a
  // redundant "Orca" entry with roles that don't apply, so we omit it there
  // and distribute its items across File / Help instead.
  // Why beside Quit: it is the quit that also puts every terminal to sleep first.
  const parkAndExitItem: Electron.MenuItemConstructorOptions = {
    id: 'park-and-exit',
    label: translateMain('menu.parkAndExit', 'Sleep Everything and Exit'),
    click: () => requestParkFromMenu()
  }

  const macAppMenu: Electron.MenuItemConstructorOptions = {
    label: options.appMenuLabel ?? app.name,
    submenu: [
      { role: 'about' },
      checkForUpdatesItem,
      settingsItem,
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      parkAndExitItem,
      { role: 'quit' }
    ]
  }

  const newWindowItem: Electron.MenuItemConstructorOptions = {
    label: `${translateMain('menu.newWindow', 'New Window')}\t${shortcutLabel('window.new')}`,
    click: () => onOpenNewWindow()
  }

  const fileMenu: Electron.MenuItemConstructorOptions = {
    label: translateMain('menu.file', 'File'),
    // Why: on Windows/Linux there is no app-named menu, so Settings and
    // Quit live under File — matching the common platform convention and
    // keeping all user-facing actions reachable from the in-window menu bar.
    submenu: [
      newWindowItem,
      { type: 'separator' },
      settingsItem,
      { type: 'separator' },
      parkAndExitItem,
      { role: 'quit', label: translateMain('menu.exit', 'Exit') }
    ]
  }

  // Why a File menu on macOS at all: the app menu owns Settings and Quit there, so this one was
  // omitted entirely. New Window belongs in File on every platform — putting it under the app menu
  // instead would be the one place a macOS user does not look for it.
  const macFileMenu: Electron.MenuItemConstructorOptions = {
    label: translateMain('menu.file', 'File'),
    submenu: [newWindowItem]
  }

  // Why: keep native menu hints while letting non-macOS Ctrl+Z/Ctrl+Y reach the focused terminal or DOM control.
  const undoRedoOptions: Electron.MenuItemConstructorOptions = isMac
    ? {}
    : { registerAccelerator: false }
  const editMenu: Electron.MenuItemConstructorOptions = {
    label: translateMain('menu.edit', 'Edit'),
    submenu: [
      { role: 'undo', ...undoRedoOptions },
      { role: 'redo', ...undoRedoOptions },
      { type: 'separator' },
      { role: 'cut' },
      createAppMenuSelectionItem({
        action: 'copy',
        label: translateMain('menu.copy', 'Copy'),
        isMac
      }),
      {
        label: translateMain('menu.paste', 'Paste'),
        accelerator: 'CmdOrCtrl+V',
        click: () => {
          // Why: a focused terminal/native-chat pane is not a native editable
          // control, so raw Electron paste cannot know which Orca surface owns it.
          const focusedWindow = BrowserWindow.getFocusedWindow()
          if (focusedWindow) {
            focusedWindow.webContents.send('ui:appMenuPaste')
            return
          }

          // Why: a macOS native panel (open/save, Go to Folder) leaves no focused
          // BrowserWindow, so overriding the paste role would strand Cmd+V as a no-op.
          if (isMac) {
            Menu.sendActionToFirstResponder('paste:')
          }
        }
      },
      createAppMenuSelectionItem({
        action: 'select-all',
        label: translateMain('menu.selectAll', 'Select All'),
        isMac
      })
    ]
  }

  const viewMenu: Electron.MenuItemConstructorOptions = {
    label: translateMain('menu.view', 'View'),
    submenu: [
      {
        label: translateMain('menu.reload', 'Reload'),
        click: () => reloadFocusedWindow(false)
      },
      {
        label: `${translateMain('menu.forceReload', 'Force Reload')}\t${shortcutLabel('app.forceReload')}`,
        click: () => reloadFocusedWindow(true)
      },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      {
        label: `${translateMain('menu.resetSize', 'Reset Size')}\t${shortcutLabel('zoom.reset')}`,
        click: (_menuItem, window) => onZoomReset(window)
      },
      {
        label: `${translateMain('menu.zoomIn', 'Zoom In')}\t${shortcutLabel('zoom.in')}`,
        click: (_menuItem, window) => onZoomIn(window)
      },
      {
        label: `${translateMain('menu.zoomOut', 'Zoom Out')}\t${shortcutLabel('zoom.out')}`,
        click: (_menuItem, window) => onZoomOut(window)
      },
      { type: 'separator' },
      {
        // Why: display-only shortcut hint — do NOT set `accelerator` here.
        // Menu accelerators intercept key events at the main-process level
        // before the renderer's keydown handler fires. The overlay
        // mutual-exclusion logic (which runs in the renderer) would be
        // bypassed if this were a real accelerator binding.
        label: `${translateMain('menu.openWorktreePalette', 'Open Worktree Palette')}\t${shortcutLabel('worktree.palette')}`
      },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      { type: 'separator' },
      buildAppearanceSubmenu({
        appearance,
        onToggleAppearance,
        onToggleLeftSidebar,
        onToggleRightSidebar,
        shortcutLabel
      })
    ]
  }

  const windowMenu: Electron.MenuItemConstructorOptions = {
    label: translateMain('menu.window', 'Window'),
    submenu: [{ role: 'minimize' }, { role: 'zoom' }]
  }

  const helpMenu: Electron.MenuItemConstructorOptions = {
    label: translateMain('menu.help', 'Help'),
    submenu: [
      crashReportItem,
      { type: 'separator' },
      featureTourItem,
      setupGuideItem,
      ...(isMac
        ? []
        : ([
            { type: 'separator' },
            { role: 'about' },
            checkForUpdatesItem
          ] satisfies Electron.MenuItemConstructorOptions[]))
    ]
  }

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [macAppMenu] : []),
    ...(isMac ? [macFileMenu] : [fileMenu]),
    editMenu,
    buildTerminalMenu({ onTerminalCommand, shortcutLabel }),
    viewMenu,
    windowMenu,
    helpMenu
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

let lastRegisterOptions: RegisterAppMenuOptions | null = null

export function registerAppMenu(options: RegisterAppMenuOptions): void {
  lastRegisterOptions = options
  buildAndApplyMenu(options)
}

/** Rebuild the application menu using the options from the most recent
 *  registerAppMenu call. Used to refresh checkbox `checked` state when
 *  settings that feed the Appearance submenu change, since Electron's
 *  menu items do not reactively re-render when the backing state updates. */
export function rebuildAppMenu(): void {
  if (lastRegisterOptions) {
    buildAndApplyMenu(lastRegisterOptions)
  }
}
