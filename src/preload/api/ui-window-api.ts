import type { MenuPopupRequest, MenuTopLevelItem } from '../../shared/app-menu-strip'
import type { ReadClipboardTextOptions } from '../../shared/clipboard-text'
import type { NativeFileDropPayload } from '../../shared/native-file-drop'
import type {
  RichMarkdownContextMenuCommandPayload,
  RichMarkdownContextMenuTableTarget
} from '../../shared/rich-markdown-context-menu'
import type {
  WorkspaceWindowClaimRequest,
  WorkspaceWindowClaimResult,
  WorkspaceWindowStartup
} from '../../shared/workspace-window-claim'

export type UiWindowApi = {
  readClipboardText: (options?: ReadClipboardTextOptions) => Promise<string>
  readSelectionClipboardText: (options?: ReadClipboardTextOptions) => Promise<string>
  saveClipboardImageAsTempFile: (args?: {
    connectionId?: string | null
    runtimeEnvironmentId?: string | null
  }) => Promise<string | null>
  writeClipboardText: (text: string) => Promise<void>
  writeTerminalClipboardText: (text: string) => Promise<void>
  writeSelectionClipboardText: (text: string) => Promise<void>
  writeClipboardImage: (dataUrl: string) => Promise<void>
  performNativePaste: (options?: { mode?: 'paste' | 'paste-and-match-style' }) => void
  performNativeSelectionAction: (action: 'copy' | 'select-all') => void
  writeClipboardFile: (
    args:
      | {
          filePath: string
          connectionId?: string | null
        }
      | string
  ) => Promise<{ ok: boolean; reason?: string }>
  onFileDrop: (callback: (data: NativeFileDropPayload) => void) => () => void
  getZoomLevel: () => number
  setZoomLevel: (level: number) => void
  syncTrafficLights: (zoomFactor: number) => void
  setMarkdownEditorFocused: (focused: boolean) => void
  setRichMarkdownContextMenuTarget: (target: RichMarkdownContextMenuTableTarget | null) => void
  setTerminalInputFocused: (focused: boolean) => void
  setFloatingFocus: (state: { panelFocused: boolean; terminalFocused: boolean }) => void
  setShortcutRecorderFocused: (focused: boolean) => void
  onRichMarkdownContextCommand: (
    callback: (payload: RichMarkdownContextMenuCommandPayload) => void
  ) => () => void
  onFullscreenChanged: (callback: (isFullScreen: boolean) => void) => () => void
  minimize: () => void
  maximize: () => void
  isMaximized: () => Promise<boolean>
  onMaximizeChanged: (callback: (isMaximized: boolean) => void) => () => void
  requestClose: () => void
  popupMenu: (request?: MenuPopupRequest) => void
  getMenuTopLevelItems: () => Promise<MenuTopLevelItem[]>
  /**
   * Ask to own a workspace in this window. A worktree binds to at most one window, so a workspace
   * another window holds answers `owned-by-another-window` and that window is raised instead.
   */
  claimWorkspace: (request: WorkspaceWindowClaimRequest) => Promise<WorkspaceWindowClaimResult>
  releaseWorkspace: () => Promise<void>
  /**
   * What this window should show once loaded.
   *
   * The saved session names one active project for the whole profile, so a window that is not the
   * first has to be told to start on the launcher rather than restore a project another window owns.
   */
  getStartupBinding: () => Promise<WorkspaceWindowStartup>
  /**
   * Open another Orca workspace window, unbound so it starts on the launcher.
   *
   * Resolves false when the caller is not itself a workspace window — main answers from the sender,
   * never from an id on the wire, so a non-window renderer cannot spawn windows.
   */
  createWindow: () => Promise<boolean>
  onWindowCloseRequested: (callback: (data: { isQuitting: boolean }) => void) => () => void
  confirmWindowClose: () => void
  notifyWindowRevealed: () => void
}
