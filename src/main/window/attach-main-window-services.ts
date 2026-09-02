/* eslint-disable max-lines -- Why: this file is the central main-window IPC wiring point; splitting it during the mobile release compatibility rebase would increase release risk. */
import { randomUUID } from 'node:crypto'

import { app, ipcMain } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { Store } from '../persistence'
import type { ReleaseBuildListResult, UpdateCheckOptions } from '../../shared/update-status-types'
import type { CreateWorktreeResult } from '../../shared/worktree/create-types'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'
import { RELEASE_CHANNELS, type ReleaseChannel } from '../../shared/release-channel'
import { registerRepoHandlers, setRepoRemoteClientNotifier } from '../ipc/repos'
import { registerWorktreeHandlers } from '../ipc/worktrees'
import { registerWorkspaceCleanupHandlers } from '../ipc/workspace-cleanup'
import {
  getLocalPtyProvider,
  registerPtyHandlers,
  type CodexHomePtySpawnedLifecycleArgs,
  type GetSelectedCodexHomePath,
  type PrepareCodexSessionResume
} from '../ipc/pty'
import { registerDaemonManagementHandlers } from '../ipc/pty-management'
import { registerSshHandlers } from '../ipc/ssh'
import { registerRemoteWorkspaceHandlers } from '../ipc/remote-workspace'
import { browserManager } from '../browser/browser-manager'
import { hasSystemMediaAccess, requestSystemMediaAccess } from '../browser/browser-media-access'
import type {
  OrcaRuntimeService,
  RuntimeNotifier,
  RuntimeWorktreeLifecycleEvent
} from '../runtime/orca-runtime'
import {
  checkForUpdatesFromMenu,
  downloadUpdate,
  getLinuxPackageInstallInstructions,
  getUpdateStatus,
  quitAndInstall,
  setupAutoUpdater,
  showLinuxPackage,
  dismissAvailableUpdate,
  dismissNudge,
  listAvailableReleaseBuilds,
  type UpdateInstallMode
} from '../updater'
import { isTrustedUIRenderer } from '../ipc/ui'
import { scheduleHistoryGc } from '../terminal-history-gc'
import { hydrateLocalPtyRegistryAtBoot } from '../memory/hydrate-local-pty-registry'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'
import { getKnownWorktreeIdsForHistoryGc } from './history-gc-worktree-ids'
import type {
  RuntimeMarkdownReadTabResult,
  RuntimeMarkdownSaveTabResult
} from '../../shared/mobile-markdown-document'
import type { RuntimeMobileSessionTabMove } from '../../shared/runtime-types'
import type { TerminalTabCreateReply } from '../../shared/terminal-reveal-identity'
import { requestMobileMarkdownFromRenderer } from './mobile-markdown-request-relay'
import { requestTerminalTabCloseFromRenderer } from './terminal-tab-close-request-relay'
import type { ClaudeAccountSelectionTarget } from '../claude-accounts/runtime-selection'
import { runWorktreeChangeInvalidators } from '../ipc/worktree-change-invalidators'
import {
  scheduleWorktreeBaseDirectoryWatcherSync,
  setWorktreeBaseDirectoryWatcherSyncContext
} from '../ipc/worktree-base-directory-watcher'
import { startFolderRepoGitUpgradeWatch } from '../ipc/folder-repo-git-upgrade'
import { logStartupMilestone } from '../startup/startup-diagnostics'
import { createRuntimeRendererNotificationSender } from './runtime-renderer-notification-sender'
import { registerRendererDocumentNavigation } from './renderer-document-navigation'
import {
  bindWindowServiceIpc,
  releaseTccPromptClaimFor,
  type WindowServiceHandlers
} from './window-service-ipc-router'

const UPDATER_SETUP_FALLBACK_MS = 15_000

// Why: a manual check can arrive before deferred setup runs, so entry points force this pending setup to configure the updater first.
let pendingAutoUpdaterSetup: (() => void) | null = null

export function ensureAutoUpdaterConfigured(): void {
  pendingAutoUpdaterSetup?.()
}

export function attachMainWindowServices(
  mainWindow: BrowserWindow,
  store: Store,
  runtime: OrcaRuntimeService,
  getSelectedCodexHomePath?: GetSelectedCodexHomePath,
  prepareClaudeAuth?: (
    target?: ClaudeAccountSelectionTarget
  ) => Promise<ClaudeRuntimeAuthPreparation>,
  options?: {
    prepareCodexSessionResume?: PrepareCodexSessionResume
    awaitLocalPtyStartup?: () => Promise<void>
    awaitLocalPtyProviderStartup?: () => Promise<void>
    onBeforeRendererReload?: (args: { webContentsId: number; ignoreCache: boolean }) => void
    // Why: lets the PTY orphan sweep skip the one crash-recovery reload (#5787).
    isRecoveryReloadInFlight?: (webContentsId: number) => boolean
    onCodexHomePtySpawned?: (args: CodexHomePtySpawnedLifecycleArgs) => void
    onPtyExit?: (id: string, exitSequence: number) => void
    onBeforeUpdateQuit?: () => void | Promise<void>
    updateInstallMode?: UpdateInstallMode
    onWorktreeLifecycle?: (event: RuntimeWorktreeLifecycleEvent) => void
  }
): void {
  const mainWebContents = mainWindow.webContents
  const windowServiceHandlers: WindowServiceHandlers = {}
  if (options?.onBeforeRendererReload) {
    windowServiceHandlers.onBeforeRendererReload = options.onBeforeRendererReload
  }
  const unbindWindowServiceIpc = bindWindowServiceIpc(mainWebContents.id, windowServiceHandlers)
  // Why: a renderer reload or crash destroys the claim's callbacks without closing the window.
  mainWebContents.on('did-start-loading', () => {
    if (mainWebContents.isLoadingMainFrame()) {
      releaseTccPromptClaimFor(mainWebContents.id)
    }
  })
  mainWebContents.on('render-process-gone', () => releaseTccPromptClaimFor(mainWebContents.id))
  mainWindow.on('closed', unbindWindowServiceIpc)
  registerRepoHandlers(mainWindow, store)
  // Why: repo IPC mutations must also invalidate paired clients' catalogs (#11994).
  setRepoRemoteClientNotifier(runtime)
  registerWorktreeHandlers(mainWindow, store, runtime, {
    onWorktreeLifecycle: options?.onWorktreeLifecycle
  })
  // Why: repo/settings mutations resync watchers through this attached main-window context.
  setWorktreeBaseDirectoryWatcherSyncContext(store, mainWindow)
  scheduleWorktreeBaseDirectoryWatcherSync(store, mainWindow)
  // Why: folder projects get no watch target, so an external `git init` needs its own
  // marker poll to upgrade them without a restart (#11477).
  startFolderRepoGitUpgradeWatch(store, mainWindow)
  registerWorkspaceCleanupHandlers(store, { runtime, getLocalPtyProvider })
  registerPtyHandlers(
    mainWindow,
    runtime,
    getSelectedCodexHomePath,
    () => store.getSettings(),
    prepareClaudeAuth,
    store,
    {
      prepareCodexSessionResume: options?.prepareCodexSessionResume,
      awaitLocalPtyStartup: options?.awaitLocalPtyStartup,
      awaitLocalPtyProviderStartup: options?.awaitLocalPtyProviderStartup,
      isRecoveryReloadInFlight: options?.isRecoveryReloadInFlight,
      onCodexHomePtySpawned: options?.onCodexHomePtySpawned,
      onPtyExit: options?.onPtyExit
    }
  )
  // Why: register after registerPtyHandlers so pty:management:* IPC re-installs on macOS re-activation (docs/daemon-staleness-ux.md §Phase 1).
  registerDaemonManagementHandlers()
  // Why: don't enumerate repo paths in background GC — `git worktree list` can touch protected macOS folders and trigger access prompts.
  scheduleHistoryGc(async () => {
    return getKnownWorktreeIdsForHistoryGc(store)
  })
  // Why: daemon PTYs survive renderer restarts, so at boot they're unregistered; hydrate so they aren't mislabeled REMOTE (idempotent, safe to re-run).
  void hydrateLocalPtyRegistryAtBoot(store)
  const localPtyStartupReady = options?.awaitLocalPtyStartup?.()
  if (localPtyStartupReady) {
    void localPtyStartupReady
      .then(() => hydrateLocalPtyRegistryAtBoot(store))
      .catch((error) => {
        console.warn(
          '[memory] Deferred pty-registry hydration skipped:',
          error instanceof Error ? error.message : String(error)
        )
      })
  }
  registerSshHandlers(store, () => mainWindow, runtime)
  registerRemoteWorkspaceHandlers(store, () => mainWindow)
  // Why: setupAutoUpdater sync-require()s electron-updater (slow on cold Windows w/ Defender, #7225), so defer past first paint; timer fallback covers crash-looping renderers.
  let updaterSetupDone = false
  const setupAutoUpdaterDeferred = (): void => {
    if (updaterSetupDone || mainWindow.isDestroyed()) {
      return
    }
    updaterSetupDone = true
    setupAutoUpdater(mainWindow, {
      getLastUpdateCheckAt: () => store.getUI().lastUpdateCheckAt,
      onBeforeQuit: async () => {
        try {
          await options?.onBeforeUpdateQuit?.()
        } finally {
          await store.flushPendingAsync()
        }
      },
      setLastUpdateCheckAt: (timestamp) => {
        store.updateUI({ lastUpdateCheckAt: timestamp })
      },
      getPendingUpdateNudgeId: () => store.getUI().pendingUpdateNudgeId ?? null,
      getDismissedUpdateNudgeId: () => store.getUI().dismissedUpdateNudgeId ?? null,
      setPendingUpdateNudgeId: (id) => {
        // Why: only the apply branch also nulls dismissedUpdateVersion so relaunch can't resurrect the old hidden card; clearing must not, or it un-dismisses.
        if (id) {
          store.updateUI({ pendingUpdateNudgeId: id, dismissedUpdateVersion: null })
        } else {
          store.updateUI({ pendingUpdateNudgeId: null })
        }
      },
      setDismissedUpdateNudgeId: (id) => {
        store.updateUI({ dismissedUpdateNudgeId: id })
      },
      getReleaseChannelOverride: () => store.getUI().releaseChannelOverride ?? null,
      installMode: options?.updateInstallMode
    })
    logStartupMilestone('updater-setup-done')
  }
  pendingAutoUpdaterSetup = setupAutoUpdaterDeferred
  mainWindow.once('ready-to-show', () => setImmediate(setupAutoUpdaterDeferred))
  const updaterSetupFallback = setTimeout(setupAutoUpdaterDeferred, UPDATER_SETUP_FALLBACK_MS)
  updaterSetupFallback.unref?.()
  registerRuntimeWindowLifecycle(mainWindow, runtime)

  const allowedPermissions = new Set(['media', 'fullscreen', 'pointerLock'])
  mainWindow.webContents.session.setPermissionRequestHandler(
    (_webContents, permission, callback, details) => {
      if (permission === 'media') {
        void requestSystemMediaAccess(details).then(callback, (error: unknown) => {
          console.error('[permissions] Failed to request media access:', error)
          callback(false)
        })
        return
      }
      callback(allowedPermissions.has(permission))
    }
  )
  mainWindow.webContents.session.setPermissionCheckHandler(
    (_webContents, permission, _origin, details) => {
      if (permission !== 'media') {
        return allowedPermissions.has(permission)
      }
      return hasSystemMediaAccess(details?.mediaType)
    }
  )

  mainWindow.on('closed', () => {
    // Why: clear main-owned guest registrations on close so stale tab→webContents ids don't leak across relaunch/hot-reload.
    browserManager.unregisterAll()
  })
}

function registerRuntimeWindowLifecycle(
  mainWindow: BrowserWindow,
  runtime: OrcaRuntimeService
): void {
  runtime.attachWindow(mainWindow.id)
  const mainWebContents = mainWindow.webContents
  const rendererNotifications = createRuntimeRendererNotificationSender({
    isWindowDestroyed: () => mainWindow.isDestroyed(),
    webContents: mainWebContents,
    onFailure: (reason) => runtime.markGraphReloadFailed(mainWindow.id, reason)
  })
  const send = rendererNotifications.send
  const windowNotifier: RuntimeNotifier = {
    worktreesChanged: (repoId, renamed) => {
      // Why: clear scan caches before the renderer handles this event, so it can't read stale TTL entries after a mutation.
      runWorktreeChangeInvalidators(repoId)
      send('worktrees:changed', renamed ? { repoId, renamed } : { repoId })
    },
    worktreeBaseStatus: (event) => send('worktree:baseStatus', event),
    worktreeRemoteBranchConflict: (event) => send('worktree:remoteBranchConflict', event),
    reposChanged: () => send('repos:changed'),
    activateWorktree: (
      repoId,
      worktreeId,
      setup?: CreateWorktreeResult['setup'],
      startup?: WorktreeStartupLaunch,
      defaultTabs?: CreateWorktreeResult['defaultTabs']
    ) => {
      send('ui:activateWorktree', {
        repoId,
        worktreeId,
        ...(setup ? { setup } : {}),
        ...(startup ? { startup } : {}),
        ...(defaultTabs ? { defaultTabs } : {})
      })
    },
    createTerminal: (worktreeId, opts) =>
      send('ui:createTerminal', {
        worktreeId,
        command: opts.command,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.env ? { env: opts.env } : {}),
        title: opts.title,
        ...(opts.presentation ? { presentation: opts.presentation } : {})
      }),
    revealTerminalSession: (worktreeId, opts) =>
      new Promise((resolve, reject) => {
        const requestId = randomUUID()
        const expectedIdentity = opts.expectedProcessIdentity
          ? opts.tabId && opts.leafId
            ? { worktreeId, tabId: opts.tabId, leafId: opts.leafId, ptyId: opts.ptyId }
            : null
          : undefined
        if (expectedIdentity === null) {
          reject(new Error('terminal_reveal_identity_required'))
          return
        }
        const timer = setTimeout(() => {
          ipcMain.removeListener('terminal:tabCreateReply', handler)
          reject(new Error('Terminal reveal timed out'))
        }, 10_000)
        const handler = (event: Electron.IpcMainEvent, reply: TerminalTabCreateReply): void => {
          // Why: requestId is renderer-supplied, so only the targeted main window may satisfy the reveal.
          if (event.sender !== mainWindow.webContents || reply.requestId !== requestId) {
            return
          }
          clearTimeout(timer)
          ipcMain.removeListener('terminal:tabCreateReply', handler)
          if (reply.error) {
            reject(new Error(reply.error))
            return
          }
          if (
            expectedIdentity &&
            (!reply.identity ||
              reply.identity.worktreeId !== expectedIdentity.worktreeId ||
              reply.identity.tabId !== expectedIdentity.tabId ||
              reply.identity.leafId !== expectedIdentity.leafId ||
              reply.identity.ptyId !== expectedIdentity.ptyId)
          ) {
            reject(new Error('terminal_reveal_identity_mismatch'))
            return
          }
          resolve({
            tabId: reply.tabId!,
            title: reply.title,
            ...(reply.identity ? { identity: reply.identity } : {})
          })
        }
        ipcMain.on('terminal:tabCreateReply', handler)
        const sent = send('ui:createTerminal', {
          requestId,
          worktreeId,
          ptyId: opts.ptyId,
          title: opts.title ?? undefined,
          ...(opts.cwd ? { cwd: opts.cwd } : {}),
          ...(opts.launchConfig ? { launchConfig: opts.launchConfig } : {}),
          ...(opts.launchToken ? { launchToken: opts.launchToken } : {}),
          ...(opts.launchAgent ? { launchAgent: opts.launchAgent } : {}),
          ...(opts.viewMode ? { viewMode: opts.viewMode } : {}),
          activate: opts.activate !== false,
          ...(opts.presentation ? { presentation: opts.presentation } : {}),
          ...(opts.surfaceOwner === false ? { surfaceOwner: false } : {}),
          // Why: pre-minted tabId aligns the renderer tab id with the paneKey baked into the PTY env, so hook events route right.
          ...(opts.tabId !== undefined ? { tabId: opts.tabId } : {}),
          ...(opts.leafId !== undefined ? { leafId: opts.leafId } : {}),
          ...(opts.splitFromLeafId !== undefined ? { splitFromLeafId: opts.splitFromLeafId } : {}),
          ...(opts.splitDirection !== undefined ? { splitDirection: opts.splitDirection } : {}),
          ...(opts.splitTelemetrySource !== undefined
            ? { splitTelemetrySource: opts.splitTelemetrySource }
            : {}),
          ...(opts.focus !== undefined ? { focus: opts.focus } : {})
        })
        if (!sent) {
          clearTimeout(timer)
          ipcMain.removeListener('terminal:tabCreateReply', handler)
          reject(new Error('runtime_unavailable'))
        }
      }),
    resolveLegacyWorkerTerminalRecovery: (paneKey, resolution, ptyId) =>
      send('agentStatus:legacyWorkerTerminalRecovery', {
        paneKey,
        resolution,
        ...(ptyId ? { ptyId } : {})
      }),
    splitTerminal: (tabId, paneRuntimeId, opts) => {
      send('ui:splitTerminal', {
        tabId,
        paneRuntimeId,
        direction: opts.direction,
        command: opts.command,
        telemetrySource: opts.telemetrySource
      })
    },
    renameTerminal: (tabId, title) => send('ui:renameTerminal', { tabId, title }),
    focusTerminal: (tabId, worktreeId, leafId) =>
      send('ui:focusTerminal', { tabId, worktreeId, leafId }),
    focusEditorTab: (tabId, worktreeId) => send('ui:focusEditorTab', { tabId, worktreeId }),
    closeSessionTab: (tabId, worktreeId) => send('ui:closeSessionTab', { tabId, worktreeId }),
    moveSessionTab: (worktreeId: string, move: RuntimeMobileSessionTabMove) =>
      send('ui:moveSessionTab', { worktreeId, ...move }),
    openFile: (worktreeId, filePath, relativePath, runtimeEnvironmentId?) =>
      send('ui:openFileFromMobile', {
        worktreeId,
        filePath,
        relativePath,
        runtimeEnvironmentId
      }),
    openDiff: (worktreeId, filePath, relativePath, staged, runtimeEnvironmentId?) =>
      send('ui:openDiffFromMobile', {
        worktreeId,
        filePath,
        relativePath,
        staged,
        runtimeEnvironmentId
      }),
    readMobileMarkdownTab: (worktreeId, tabId) =>
      requestMobileMarkdownFromRenderer(mainWindow, {
        operation: 'read',
        worktreeId,
        tabId
      }) as Promise<RuntimeMarkdownReadTabResult>,
    saveMobileMarkdownTab: (worktreeId, tabId, baseVersion, content) =>
      requestMobileMarkdownFromRenderer(mainWindow, {
        operation: 'save',
        worktreeId,
        tabId,
        baseVersion,
        content
      }) as Promise<RuntimeMarkdownSaveTabResult>,
    closeTerminal: (tabId, paneRuntimeId) => send('ui:closeTerminal', { tabId, paneRuntimeId }),
    closeTerminalTab: (tabId, options) =>
      requestTerminalTabCloseFromRenderer(mainWindow, tabId, options),
    sleepWorktree: (worktreeId) => send('ui:sleepWorktree', { worktreeId }),
    resumeSleepingAgents: (worktreeId) => send('ui:resumeSleepingAgents', { worktreeId }),
    terminalFitOverrideChanged: (ptyId, mode, cols, rows) =>
      send('runtime:terminalFitOverrideChanged', { ptyId, mode, cols, rows }),
    terminalDriverChanged: (ptyId, driver) =>
      send('runtime:terminalDriverChanged', { ptyId, driver }),
    nativeChatLaunchDraftResolved: (tabId, resolution) =>
      send('runtime:nativeChatLaunchDraftResolved', { tabId, ...resolution }),
    browserDriverChanged: (browserPageId, driver) =>
      send('runtime:browserDriverChanged', { browserPageId, driver })
  }
  runtime.setNotifier(windowNotifier, mainWindow.id)
  registerRendererDocumentNavigation(mainWebContents, () => {
    rendererNotifications.onMainFrameReloadStarted()
    const fence = runtime.markRendererReloading(mainWindow.id)
    return () => {
      if (fence && runtime.markRendererReloadCancelled(mainWindow.id, fence)) {
        rendererNotifications.onMainFrameReloadCancelled()
      }
    }
  })
  mainWebContents.on('did-finish-load', () => {
    rendererNotifications.onMainFrameLoadFinished()
  })
  mainWebContents.on('render-process-gone', () => {
    rendererNotifications.onRendererProcessGone()
  })
  mainWindow.on('closed', () => {
    rendererNotifications.close()
    runtime.markGraphUnavailable(mainWindow.id)
    // Why: the notifier closes over this window, so it goes with it — and keying by window is what
    // makes that safe. It used to need a token to prove the clear was not a stale window wiping the
    // live one's notifier out of the single slot they shared.
    runtime.setNotifier(null, mainWindow.id)
  })
}

export function registerUpdaterHandlers(_store: Store): void {
  ipcMain.removeHandler('updater:getStatus')
  ipcMain.removeHandler('updater:getVersion')
  ipcMain.removeHandler('updater:check')
  ipcMain.removeHandler('updater:download')
  ipcMain.removeHandler('updater:quitAndInstall')
  ipcMain.removeHandler('updater:dismissNudge')
  ipcMain.removeHandler('updater:dismissAvailableUpdate')
  ipcMain.removeHandler('updater:getLinuxPackageInstallInstructions')
  ipcMain.removeHandler('updater:showLinuxPackage')
  ipcMain.removeHandler('updater:listBuilds')

  ipcMain.handle('updater:getStatus', () => getUpdateStatus())
  ipcMain.handle('updater:getVersion', () => app.getVersion())
  ipcMain.handle('updater:check', (_event, options?: UpdateCheckOptions) => {
    ensureAutoUpdaterConfigured()
    return checkForUpdatesFromMenu(options)
  })
  ipcMain.handle('updater:download', () => downloadUpdate())
  ipcMain.handle('updater:quitAndInstall', () => quitAndInstall())
  ipcMain.handle('updater:dismissNudge', () => dismissNudge())
  ipcMain.handle('updater:dismissAvailableUpdate', () => dismissAvailableUpdate())
  // Why: the response carries a local package path and the reveal touches the native desktop, so
  // neither may be reached from a guest, dashboard popout, stale window, or utility renderer.
  ipcMain.handle('updater:getLinuxPackageInstallInstructions', (event) => {
    assertTrustedUpdaterRecoverySender(event)
    return getLinuxPackageInstallInstructions()
  })
  ipcMain.handle('updater:showLinuxPackage', (event) => {
    assertTrustedUpdaterRecoverySender(event)
    return showLinuxPackage()
  })
  ipcMain.handle(
    'updater:listBuilds',
    async (_event, channel: ReleaseChannel): Promise<ReleaseBuildListResult> => {
      if (!RELEASE_CHANNELS.includes(channel)) {
        return { ok: false, channel, message: `Unknown release channel "${channel}".` }
      }
      try {
        return { ok: true, channel, builds: await listAvailableReleaseBuilds(channel) }
      } catch (error) {
        // Why: a network/rate-limit failure is expected here; return it as data so
        // the picker can render the reason instead of rejecting the invoke.
        return { ok: false, channel, message: String((error as Error)?.message ?? error) }
      }
    }
  )
}

function assertTrustedUpdaterRecoverySender(event: IpcMainInvokeEvent): void {
  if (!isTrustedUIRenderer(event.sender)) {
    throw new Error('Unauthorized updater package recovery sender')
  }
}
