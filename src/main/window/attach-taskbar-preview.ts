/**
 * Giving one application window a live Windows taskbar thumbnail.
 *
 * This is the seam between the controller (which knows DWM) and Orca (which knows which terminal a
 * window is about). It owns exactly one controller per native window and releases it when that
 * window closes, because the native opt-in is a property of the window handle: a controller that
 * outlived its window would leave a later window forced-iconic, frozen on a picture of a terminal
 * nobody is running.
 *
 * Two things here are load-bearing and easy to get wrong:
 *
 * The subject is re-resolved on every demand, through the window's *current* renderer. A reload
 * replaces the webContents while the window and its project binding survive, so caching the binding
 * at attach time would pin the thumbnail to whatever the window owned at startup.
 *
 * And the terminal subscription is `subscribeToTerminalData` alone. The in-app hover preview pairs
 * it with `registerRawTerminalViewSubscriber`, which announces view presence and changes provider
 * thinning — that is a participant's call, not an observer's. Copying the hover preview wholesale
 * would make the taskbar visible to the runtime it is supposed to be invisible to.
 */
import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import {
  createTaskbarPreviewController,
  type TaskbarPreviewController,
  type TaskbarPreviewDiagnostic,
  type TaskbarPreviewMessageWindow
} from './taskbar-preview-controller'
import { loadTaskbarPreviewNative, type TaskbarPreviewNativeLoad } from './taskbar-preview-native'
import {
  resolveTaskbarPreviewSubject,
  type TaskbarPreviewSessionView,
  type TaskbarPreviewSubject
} from './taskbar-preview-subject'
import { getWorkspaceWindowForRenderer } from './workspace-window-registry'

export type TaskbarPreviewHostWindow = TaskbarPreviewMessageWindow & {
  readonly webContents: { readonly id: number }
  on(event: 'minimize' | 'restore' | 'closed', listener: () => void): unknown
}

export type TaskbarPreviewSessionStore = {
  getWorkspaceSession(hostId?: string | null): TaskbarPreviewSessionView
  /** Sessions are partitioned per execution host, so the window's worktree decides which to read. */
  getWorkspaceSessionHostIds?: () => readonly string[]
}

export type TaskbarPreviewTerminalRuntime = {
  readVisibleTerminalLines(ptyId: string): Promise<{ lines: readonly string[] } | null>
  subscribeToTerminalData(ptyId: string, listener: (data: string) => void): () => void
  /** Read-only: a size *query* is not a resize, and this surface never sets one. */
  getTerminalSize(ptyId: string): { cols: number; rows: number } | null
}

export type TaskbarPreviewAttachDiagnostic =
  | TaskbarPreviewDiagnostic
  | { kind: 'native'; load: TaskbarPreviewNativeLoad }
  /**
   * Iconic state, reported because a thumbnail is only demanded while the window is iconic. A run
   * that lost that state mid-flight produces the same reading as a platform that never delivers —
   * no demands — so the edges belong in the record beside them.
   */
  | { kind: 'window'; state: 'minimize' | 'restore' }

export type TaskbarPreviewAttachment = {
  dispose(): void
  /** Test seam: lets a caller assert the subject without driving a native demand. */
  resolveSubject(): TaskbarPreviewSubject
  readonly controller: TaskbarPreviewController
}

/**
 * The session partition holding this worktree.
 *
 * A worktree lives on exactly one execution host, and its id is unique across them, so the
 * partition that records a tab for it is the right one. Falling back to the local partition when no
 * host claims it keeps the unavailable *reason* truthful — "no tab recorded" — instead of inventing
 * a host.
 */
export function selectWorkspaceSessionForWorktree(
  store: TaskbarPreviewSessionStore,
  worktreeId: string
): TaskbarPreviewSessionView {
  const hostIds = store.getWorkspaceSessionHostIds?.() ?? []
  for (const hostId of hostIds) {
    const session = store.getWorkspaceSession(hostId)
    if (session.activeTabIdByWorktree?.[worktreeId]) {
      return session
    }
  }
  return store.getWorkspaceSession()
}

function defaultLoadAddon(): TaskbarPreviewNativeLoad {
  return loadTaskbarPreviewNative({
    platform: process.platform,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    projectRoot: app.getAppPath(),
    join,
    fileExists: existsSync
  })
}

let cachedLoad: TaskbarPreviewNativeLoad | null = null

/** Loaded once per process: the binary is the same for every window, and so is its absence. */
function loadOnce(load: () => TaskbarPreviewNativeLoad): TaskbarPreviewNativeLoad {
  cachedLoad ??= load()
  return cachedLoad
}

export function resetTaskbarPreviewNativeCacheForTest(): void {
  cachedLoad = null
}

/**
 * Returns null when the window gets no thumbnail — not Windows, no addon, or a window that cannot
 * hand over a native handle. Never throws: this is an enhancement, and a window whose preview could
 * not attach is an ordinary window.
 */
export function attachTaskbarPreview(args: {
  window: TaskbarPreviewHostWindow
  store: TaskbarPreviewSessionStore
  runtime: TaskbarPreviewTerminalRuntime
  loadAddon?: () => TaskbarPreviewNativeLoad
  onDiagnostic?: (event: TaskbarPreviewAttachDiagnostic) => void
}): TaskbarPreviewAttachment | null {
  try {
    return attachOrNull(args)
  } catch (error) {
    // The registrar that calls this goes on to wire permissions, the updater and the browser
    // manager. An enhancement that threw here would take all of them down with it and leave a
    // window that opened but does not work — so every failure resolves to "no thumbnail".
    args.onDiagnostic?.({
      kind: 'native',
      load: {
        status: 'unavailable',
        reason: 'load-failed',
        detail: error instanceof Error ? error.message : String(error)
      }
    })
    return null
  }
}

function attachOrNull(args: {
  window: TaskbarPreviewHostWindow
  store: TaskbarPreviewSessionStore
  runtime: TaskbarPreviewTerminalRuntime
  loadAddon?: () => TaskbarPreviewNativeLoad
  onDiagnostic?: (event: TaskbarPreviewAttachDiagnostic) => void
}): TaskbarPreviewAttachment | null {
  const load = loadOnce(args.loadAddon ?? defaultLoadAddon)
  if (load.status !== 'available') {
    args.onDiagnostic?.({ kind: 'native', load })
    return null
  }

  const resolveSubject = (): TaskbarPreviewSubject => {
    // Through the *current* renderer, not one captured at attach time.
    const record = getWorkspaceWindowForRenderer(args.window.webContents.id)
    const binding = record?.binding ?? null
    if (!binding) {
      return resolveTaskbarPreviewSubject({ binding: null, session: {}, livePtyIds: new Set() })
    }
    const session = selectWorkspaceSessionForWorktree(args.store, binding.worktreeId)
    const tabId = session.activeTabIdByWorktree?.[binding.worktreeId]
    // Only the panes this tab could possibly name are probed, so liveness costs a handful of map
    // lookups rather than an inventory sweep on the shell's schedule.
    const candidates = tabId
      ? Object.values(session.terminalLayoutsByTabId?.[tabId]?.ptyIdsByLeafId ?? {})
      : []
    const livePtyIds = new Set(
      candidates.filter((ptyId) => args.runtime.getTerminalSize(ptyId) !== null)
    )
    return resolveTaskbarPreviewSubject({ binding, session, livePtyIds })
  }

  const controller = createTaskbarPreviewController({
    window: args.window,
    addon: load.addon,
    resolveSubject,
    readViewportLines: async (ptyId) => {
      const state = await args.runtime.readVisibleTerminalLines(ptyId)
      return state?.lines ?? null
    },
    // The payload is deliberately dropped. This surface wants to know that state moved, not what
    // moved — holding the bytes would give the thumbnail its own copy of the user's terminal.
    subscribeToTerminalOutput: (ptyId, onOutput) =>
      args.runtime.subscribeToTerminalData(ptyId, () => onOutput()),
    ...(args.onDiagnostic ? { onDiagnostic: args.onDiagnostic } : {})
  })

  controller.start()

  // Minimize and restore bracket exactly the interval in which the thumbnail matters, and the user
  // cannot change panes in a window they cannot see — so these two edges are enough to keep the
  // output subscription pointed at the right pane without polling anything.
  args.window.on('minimize', () => {
    args.onDiagnostic?.({ kind: 'window', state: 'minimize' })
    controller.retarget()
  })
  args.window.on('restore', () => {
    args.onDiagnostic?.({ kind: 'window', state: 'restore' })
    controller.retarget()
  })
  args.window.on('closed', () => controller.dispose())

  return { dispose: () => controller.dispose(), resolveSubject, controller }
}
