import { readFile } from 'node:fs/promises'
import type { ParkSaveCheck } from './park-coordinator'

type SavedTab = { id?: unknown; dormancy?: unknown }
type SavedSession = { tabsByWorktree?: Record<string, SavedTab[] | undefined> }
type SavedProfile = {
  workspaceSession?: SavedSession
  workspaceSessionsByHostId?: Record<string, SavedSession | undefined>
}

function collectSavedTabs(profile: SavedProfile): Map<string, SavedTab> {
  const tabs = new Map<string, SavedTab>()
  const sessions = [
    profile.workspaceSession,
    ...Object.values(profile.workspaceSessionsByHostId ?? {})
  ]
  for (const session of sessions) {
    for (const worktreeTabs of Object.values(session?.tabsByWorktree ?? {})) {
      for (const tab of worktreeTabs ?? []) {
        if (typeof tab?.id === 'string') {
          tabs.set(tab.id, tab)
        }
      }
    }
  }
  return tabs
}

/**
 * Whether the profile file on disk — not the store in memory — holds every slept tab as dormant.
 * An unreadable file, a missing tab and an undormant tab are all refusals: each would mean a
 * relaunch starts something or loses a row.
 */
export async function checkSleptTabsSaved(
  dataFile: string,
  tabIds: readonly string[]
): Promise<ParkSaveCheck> {
  let profile: SavedProfile
  try {
    profile = JSON.parse(await readFile(dataFile, 'utf8')) as SavedProfile
  } catch (error) {
    return { ok: false, detail: `saved-session-unreadable: ${String(error)}` }
  }
  const saved = collectSavedTabs(profile)
  const missing = tabIds.filter((tabId) => !saved.has(tabId))
  if (missing.length > 0) {
    return { ok: false, detail: `saved-session-missing-tabs: ${missing.length}` }
  }
  const awake = tabIds.filter((tabId) => !saved.get(tabId)?.dormancy)
  if (awake.length > 0) {
    return { ok: false, detail: `saved-session-tabs-not-dormant: ${awake.length}` }
  }
  return { ok: true }
}
