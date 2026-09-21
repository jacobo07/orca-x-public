import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  WorktreeBasePollEvent,
  WorktreeBaseSubscription,
  WorktreePollerWindowVisibility
} from './worktree-base-directory-poller'
import { PRIMARY_CHECKOUT_METADATA_FILES } from './worktree-git-common-polling'
import { getWorktreeObservationClock } from './worktree-observation-clock'

type PrimaryMetadataSnapshot = {
  signatures: Map<string, string>
  statusRefPaths: Set<string>
}

async function snapshotPrimaryCheckoutMetadata(
  commonDirPath: string,
  getStatusRefPaths: () => readonly string[]
): Promise<PrimaryMetadataSnapshot> {
  const signatures = new Map<string, string>()
  const statusRefPaths = new Set(getStatusRefPaths())
  const paths = [
    ...PRIMARY_CHECKOUT_METADATA_FILES.map((name) => join(commonDirPath, name)),
    ...statusRefPaths
  ]
  await Promise.all(
    paths.map(async (filePath) => {
      try {
        const value = await stat(filePath)
        if (value.isFile()) {
          signatures.set(filePath, `${value.mtimeMs}:${value.ctimeMs}:${value.ino}:${value.size}`)
        }
      } catch {
        // Missing dynamic leaves remain selected so later creation is visible.
      }
    })
  )
  return { signatures, statusRefPaths }
}

function classifyMetadataSignatureDiff(
  prevSignature: string | undefined,
  nextSignature: string | undefined
): WorktreeBasePollEvent['type'] | null {
  if (prevSignature === undefined && nextSignature === undefined) {
    return null
  }
  if (prevSignature === undefined) {
    return 'create'
  }
  if (nextSignature === undefined) {
    return 'delete'
  }
  return prevSignature === nextSignature ? null : 'update'
}

function diffPrimaryMetadata(
  prev: PrimaryMetadataSnapshot,
  next: PrimaryMetadataSnapshot
): WorktreeBasePollEvent[] {
  const events: WorktreeBasePollEvent[] = []
  const paths = new Set([...prev.signatures.keys(), ...next.signatures.keys()])
  for (const path of paths) {
    const isStatusRef = prev.statusRefPaths.has(path) || next.statusRefPaths.has(path)
    if (isStatusRef && (!prev.statusRefPaths.has(path) || !next.statusRefPaths.has(path))) {
      continue
    }
    const type = classifyMetadataSignatureDiff(prev.signatures.get(path), next.signatures.get(path))
    if (type) {
      events.push({ type, path })
    }
  }
  return events
}

export async function startGitCommonPrimaryPolling(
  commonDirPath: string,
  getStatusRefPaths: () => readonly string[],
  onEvents: (events: WorktreeBasePollEvent[]) => void,
  pollIntervalMs: number,
  visibility: WorktreePollerWindowVisibility,
  onFullScan?: () => void
): Promise<WorktreeBaseSubscription> {
  let disposed = false
  let ticking = false
  let snapshot = await snapshotPrimaryCheckoutMetadata(commonDirPath, getStatusRefPaths)
  let parkedWhileHidden = false

  const registration = getWorktreeObservationClock(pollIntervalMs).register(
    async () => {
      if (disposed) {
        return 'observed'
      }
      if (!visibility.isWindowVisible()) {
        parkedWhileHidden = true
        return 'parked'
      }
      if (ticking) {
        return 'observed'
      }
      ticking = true
      onFullScan?.()
      try {
        const next = await snapshotPrimaryCheckoutMetadata(commonDirPath, getStatusRefPaths)
        if (disposed) {
          return 'observed'
        }
        const events = diffPrimaryMetadata(snapshot, next)
        snapshot = next
        if (events.length > 0) {
          registration.noteActivity()
          onEvents(events)
        }
      } catch {
        // Transient fs error: keep the previous snapshot and retry next tick.
      } finally {
        ticking = false
      }
      return 'observed'
    },
    { isPinnedActive: () => getStatusRefPaths().length > 0 }
  )

  const unsubscribeVisibility = visibility.onWindowBecameVisible(() => {
    if (disposed || !parkedWhileHidden) {
      return
    }
    parkedWhileHidden = false
    registration.runNow(false)
  })

  return {
    unsubscribe: async () => {
      disposed = true
      registration.unregister()
      unsubscribeVisibility()
    }
  }
}
