/**
 * What an active worktree-base watch is, and what it does with the events it receives.
 *
 * Split from the watcher itself because the watcher's job is which paths to watch and when to
 * re-sync them, while this is what one watch does when something happens under a path it holds.
 */
import type { BrowserWindow } from 'electron'
import {
  collectLocalWorktreeBaseChanges,
  collectRemoteWorktreeBaseChanges,
  hasCollectedWorktreeBaseChanges
} from './worktree-base-directory-change-collector'
import {
  scheduleWorktreeBaseNotification,
  supportsWorktreeHeadIdentityRefresh
} from './worktree-base-directory-notifications'
import type { WorktreeBaseWatchTarget } from './worktree-base-directory-event-filter'
import {
  invalidateActiveGitStatusRefResolution,
  invalidateGitStatusRefResolutionForPaths
} from './worktree-git-status-ref-watch'
import {
  createWorktreeHeadIdentityRefreshState,
  type WorktreeHeadIdentityRefreshState
} from './worktree-head-identity-refresh'
import { WorktreeWatcherFailureRefreshCooldown } from './worktree-watcher-failure-refresh-cooldown'
import { survivingAppWindow } from '../window/surviving-app-window'

export type ActiveWatch = WorktreeBaseWatchTarget & {
  mainWindow: BrowserWindow
  subscription: { unsubscribe: () => Promise<void> }
  notifyTimer: ReturnType<typeof setTimeout> | null
  pendingStructureRepoIds: Set<string>
  pendingGitStatusRepoIds: Set<string>
  pendingHeadIdentityRepoIds: Set<string>
  headIdentityRefresh: WorktreeHeadIdentityRefreshState
  gitStatusRefPaths: Set<string>
  watcherFailureRefresh: WorktreeWatcherFailureRefreshCooldown
  disposed: boolean
}

export type ListActiveWatches = () => Iterable<ActiveWatch>

/**
 * The window this watch should answer to, re-pointed at a survivor when its own has gone.
 *
 * One watcher serves every window — they are keyed by path, not by window — so the window a watch
 * captured was only ever "who to answer to". Closing it left a survivor holding a live watcher
 * whose every event was dropped on the way out.
 */
export function liveWindowForWatch(watch: ActiveWatch): BrowserWindow | null {
  if (!watch.mainWindow.isDestroyed()) {
    return watch.mainWindow
  }
  const survivor = survivingAppWindow()
  if (survivor) {
    // Adopt it, so the visibility poller and later events follow the same window this one does.
    watch.mainWindow = survivor
  }
  return survivor
}

export function createActiveWatch(
  target: WorktreeBaseWatchTarget,
  mainWindow: BrowserWindow,
  subscription: ActiveWatch['subscription'],
  gitStatusRefPaths: Set<string>
): ActiveWatch {
  return {
    ...target,
    mainWindow,
    subscription,
    notifyTimer: null,
    pendingStructureRepoIds: new Set(),
    pendingGitStatusRepoIds: new Set(),
    pendingHeadIdentityRepoIds: new Set(),
    headIdentityRefresh: createWorktreeHeadIdentityRefreshState(),
    gitStatusRefPaths,
    watcherFailureRefresh: new WorktreeWatcherFailureRefreshCooldown(),
    disposed: false
  }
}

export function handleLocalWatchEvents(
  watch: ActiveWatch,
  error: Error | null,
  events: { type: 'create' | 'update' | 'delete'; path: string }[],
  listWatches: ListActiveWatches
): void {
  if (watch.disposed || !liveWindowForWatch(watch)) {
    return
  }
  if (error) {
    console.warn(`[worktree-base-watcher] watcher failed for ${watch.path}:`, error)
    invalidateActiveGitStatusRefResolution(watch, listWatches)
    if (watch.watcherFailureRefresh.consume()) {
      scheduleWorktreeBaseNotification(watch, { structureRepoIds: [...watch.repos.keys()] })
    }
    return
  }
  watch.watcherFailureRefresh.reset()
  invalidateGitStatusRefResolutionForPaths(
    watch,
    events.map((event) => event.path),
    listWatches
  )
  const changes = collectLocalWorktreeBaseChanges(watch, events)
  if (hasCollectedWorktreeBaseChanges(changes)) {
    scheduleWorktreeBaseNotification(watch, changes)
  }
}

export function handleRemoteWatchEvents(
  watch: ActiveWatch,
  events: Parameters<typeof collectRemoteWorktreeBaseChanges>[1],
  listWatches: ListActiveWatches
): void {
  if (watch.disposed || !liveWindowForWatch(watch)) {
    return
  }
  invalidateGitStatusRefResolutionForPaths(
    watch,
    events.flatMap((event) =>
      event.kind === 'overflow' ? [] : [event.absolutePath, event.oldAbsolutePath]
    ),
    listWatches
  )
  const changes = collectRemoteWorktreeBaseChanges(watch, events)
  if (changes.overflow) {
    invalidateActiveGitStatusRefResolution(watch, listWatches)
    scheduleWorktreeBaseNotification(watch, { structureRepoIds: [...watch.repos.keys()] })
    return
  }
  if (hasCollectedWorktreeBaseChanges(changes)) {
    scheduleWorktreeBaseNotification(watch, changes)
  }
}

export { supportsWorktreeHeadIdentityRefresh }
