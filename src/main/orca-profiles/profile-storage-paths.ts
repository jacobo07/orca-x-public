import { app } from 'electron'
import { join } from 'node:path'

const LEGACY_DATA_FILE_NAME = 'orca-data.json'
const LEGACY_BROWSER_SESSION_META_FILE_NAME = 'browser-session-meta.json'
const PROFILE_INDEX_FILE_NAME = 'orca-profile-index.json'
const PROFILE_DATA_FILE_NAME = 'orca-data.json'
const PROFILE_BROWSER_SESSION_META_FILE_NAME = 'browser-session-meta.json'
const PROFILE_DIRECTORY_NAME = 'profiles'
const PROFILE_CONVERSATIONS_DIRECTORY_NAME = 'conversations'
const PROFILE_BACKLOG_DIRECTORY_NAME = 'backlog'

export const LEGACY_BACKUP_COUNT = 5

let profileUserDataPath: string | null = null

export function initOrcaProfilePaths(): void {
  profileUserDataPath = app.getPath('userData')
}

export function getProfileUserDataPath(): string {
  if (!profileUserDataPath) {
    profileUserDataPath = app.getPath('userData')
  }
  return profileUserDataPath
}

export function getOrcaProfileIndexPath(userDataPath = getProfileUserDataPath()): string {
  return join(userDataPath, PROFILE_INDEX_FILE_NAME)
}

export function getOrcaProfilesDirectory(userDataPath = getProfileUserDataPath()): string {
  return join(userDataPath, PROFILE_DIRECTORY_NAME)
}

export function getOrcaProfileDirectory(
  profileId: string,
  userDataPath = getProfileUserDataPath()
): string {
  return join(getOrcaProfilesDirectory(userDataPath), profileId)
}

/**
 * Where a profile's Orca conversations live: one record per file, published by ConversationStore.
 *
 * Nested inside the profile directory rather than beside it, so a profile owns its conversations
 * the way it owns its data file — deleting a profile takes them with it instead of orphaning them
 * in a shared pool keyed by an id nobody reads. Isolation is a property of this owner; callers do
 * not compose the path themselves, because a caller that forgets the profile id produces a single
 * shared directory and every profile then reads every conversation.
 */
export function getOrcaConversationsDirectory(
  profileId: string,
  userDataPath = getProfileUserDataPath()
): string {
  return join(
    getOrcaProfileDirectory(profileId, userDataPath),
    PROFILE_CONVERSATIONS_DIRECTORY_NAME
  )
}

/** A profile's intent ledger; isolation is this owner's property, callers never compose the path. */
export function getOrcaBacklogDirectory(
  profileId: string,
  userDataPath = getProfileUserDataPath()
): string {
  return join(getOrcaProfileDirectory(profileId, userDataPath), PROFILE_BACKLOG_DIRECTORY_NAME)
}

export function getOrcaProfileDataFile(
  profileId: string,
  userDataPath = getProfileUserDataPath()
): string {
  return join(getOrcaProfileDirectory(profileId, userDataPath), PROFILE_DATA_FILE_NAME)
}

export function getOrcaProfileBrowserSessionMetaFile(
  profileId: string,
  userDataPath = getProfileUserDataPath()
): string {
  return join(
    getOrcaProfileDirectory(profileId, userDataPath),
    PROFILE_BROWSER_SESSION_META_FILE_NAME
  )
}

export function legacyDataFilePath(userDataPath: string): string {
  return join(userDataPath, LEGACY_DATA_FILE_NAME)
}

export function legacyBrowserSessionMetaPath(userDataPath: string): string {
  return join(userDataPath, LEGACY_BROWSER_SESSION_META_FILE_NAME)
}

export function legacyBackupPath(userDataPath: string, index: number): string {
  return `${legacyDataFilePath(userDataPath)}.bak.${index}`
}

export function profileBackupPath(profileDataFile: string, index: number): string {
  return `${profileDataFile}.bak.${index}`
}
