import type { ExecutionHostId } from '../../shared/execution-host'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { Repo } from '../../shared/repo-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { DeskReadResult } from '../../shared/desk-continuity-read-types'
import {
  projectDesk,
  type DeskHostInput,
  type DeskLiveness,
  type DeskWorkspaceIdentity
} from '../../shared/desk-continuity-projection'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import { normalizeWindowTopology } from '../window/window-topology'

export type DeskReadStore = {
  getWorkspaceSessionHostIds: () => ExecutionHostId[]
  getWorkspaceSession: (hostId: string) => WorkspaceSessionState
  getUI: () => { windowTopology?: unknown }
  getRepo: (id: string) => Repo | undefined
  getFolderWorkspace: (id: string) => FolderWorkspace | undefined
}

export type DeskReadDeps = {
  store: DeskReadStore
  /** Ids of the sessions the local terminal host is running now. Throws when it cannot be asked. */
  listLocalSessionIds: () => Promise<string[]>
  now: () => number
}

function describeWorkspace(store: DeskReadStore, key: string): DeskWorkspaceIdentity {
  if (key.startsWith('folder:')) {
    const folder = store.getFolderWorkspace(key.slice('folder:'.length))
    return folder
      ? { kind: 'known', name: folder.name, path: folder.folderPath }
      : { kind: 'missing' }
  }
  const worktreeId = key.startsWith('worktree:') ? key.slice('worktree:'.length) : key
  const parsed = splitWorktreeIdForFilesystem(worktreeId)
  if (!parsed) {
    return { kind: 'unknown' }
  }
  const repo = store.getRepo(parsed.repoId)
  return repo
    ? { kind: 'known', name: repo.displayName, path: parsed.worktreePath }
    : { kind: 'missing' }
}

async function localLiveness(deps: DeskReadDeps): Promise<DeskLiveness> {
  try {
    return { kind: 'observed', liveSessionIds: new Set(await deps.listLocalSessionIds()) }
  } catch {
    // Why unknown: a listing that failed says nothing about which sessions are running.
    return { kind: 'unknown', reason: 'host-unreachable' }
  }
}

function readWindows(store: DeskReadStore): ReturnType<typeof normalizeWindowTopology> {
  try {
    return normalizeWindowTopology(store.getUI().windowTopology)
  } catch {
    return null
  }
}

/**
 * Read the desk from the store and the local terminal host.
 *
 * Remote hosts report `not-asked`: their relay listing folds a failed peer into an empty list, so
 * asking it today could only ever produce a false "stopped". Unknown is the honest answer until the
 * relay can say which of the two it means.
 */
export async function readDesk(deps: DeskReadDeps): Promise<DeskReadResult> {
  const { store } = deps
  const local = await localLiveness(deps)
  const hosts: DeskHostInput[] = store.getWorkspaceSessionHostIds().map((hostId) => {
    const liveness: DeskLiveness =
      hostId === 'local' ? local : { kind: 'unknown', reason: 'not-asked' }
    try {
      return {
        hostId,
        session: { kind: 'loaded', state: store.getWorkspaceSession(hostId) },
        liveness
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unreadable'
      return { hostId, session: { kind: 'unreadable', reason }, liveness }
    }
  })
  return {
    status: 'loaded',
    readAt: deps.now(),
    projection: projectDesk({
      hosts,
      windows: readWindows(store),
      describeWorkspace: (key) => describeWorkspace(store, key)
    })
  }
}
