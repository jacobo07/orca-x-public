import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parseExecutionHostId } from '../../shared/execution-host'
import type {
  WorkingSetFactPresence,
  WorkingSetPaneRestoreFacts,
  WorkingSetRestoreEvidence,
  WorkingSetScopeKey
} from '../../shared/project-working-set-store-types'
import type {
  ProjectWorkingSetManifest,
  WorkingSetPane
} from '../../shared/project-working-set-types'
import { toHostReadableTranscriptPath } from '../native-chat/host-readable-transcript-path'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import { readSealedScrollbackPresence } from './working-set-scrollback-seal'

/**
 * Facts about the world a working set's restore depends on, gathered by main from the manifest it
 * read itself. Every probe answers present / absent / unknown, and absent requires the filesystem to
 * have said so: an unreachable host, a stalled mount or a search that merely found nothing is unknown.
 */

export type RestoreEvidenceDeps = {
  statPath: (path: string) => Promise<{ isDirectory: () => boolean; isFile: () => boolean }>
  hostReadableTranscript: (path: string) => Promise<string | null>
  findTranscript: (pane: ProviderPane) => Promise<string | null>
  probeTimeoutMs: number
  platform: NodeJS.Platform
}

type ProviderPane = WorkingSetPane & { resume: { kind: 'provider-session' } }

const defaultDeps: RestoreEvidenceDeps = {
  statPath: (path) => stat(path),
  hostReadableTranscript: (path) => toHostReadableTranscriptPath(path),
  findTranscript: (pane) =>
    resolveSessionFilePath(pane.resume.agent, pane.resume.providerSession.id),
  probeTimeoutMs: 2_000,
  platform: process.platform
}

function errorCode(error: unknown): string | null {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' ? code : null
}

async function bounded(
  probe: () => Promise<WorkingSetFactPresence>,
  timeoutMs: number
): Promise<WorkingSetFactPresence> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<WorkingSetFactPresence>((resolve) => {
    timer = setTimeout(() => resolve('unknown'), timeoutMs)
  })
  try {
    return await Promise.race([probe().catch(() => 'unknown' as const), timeout])
  } finally {
    clearTimeout(timer)
  }
}

async function presenceOf(
  path: string,
  kind: 'directory' | 'file',
  deps: RestoreEvidenceDeps
): Promise<WorkingSetFactPresence> {
  try {
    const info = await deps.statPath(path)
    const matches = kind === 'directory' ? info.isDirectory() : info.isFile()
    return matches ? 'present' : 'unknown'
  } catch (error) {
    const code = errorCode(error)
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unknown'
  }
}

async function transcriptPresence(
  pane: WorkingSetPane,
  deps: RestoreEvidenceDeps
): Promise<WorkingSetFactPresence | null> {
  if (pane.resume.kind !== 'provider-session') {
    return null
  }
  const providerPane = pane as ProviderPane
  const recorded = providerPane.resume.providerSession.transcriptPath
  // Why only a native absolute path can prove absence: a WSL guest path on Windows goes through
  // distro probing, where "not found" also covers a stopped distro.
  const wslGuest = deps.platform === 'win32' && recorded?.startsWith('/')
  if (recorded && isAbsolute(recorded) && !wslGuest) {
    return presenceOf(recorded, 'file', deps)
  }
  if (recorded) {
    return (await deps.hostReadableTranscript(recorded)) ? 'present' : 'unknown'
  }
  // Why a miss is unknown: the search covers default roots, and a session may live under another
  // account's config directory.
  return (await deps.findTranscript(providerPane)) ? 'present' : 'unknown'
}

export async function gatherWorkingSetRestoreEvidence(
  root: string,
  manifest: ProjectWorkingSetManifest,
  deps: RestoreEvidenceDeps = defaultDeps
): Promise<WorkingSetRestoreEvidence> {
  const scope: WorkingSetScopeKey = manifest.scope
  const local = parseExecutionHostId(scope.executionHostId)?.kind === 'local'
  const within = (probe: () => Promise<WorkingSetFactPresence>) =>
    bounded(probe, deps.probeTimeoutMs)
  const { location } = manifest.scope
  const locationPath =
    location.kind === 'repo-worktree' ? location.worktreePath : location.folderPath
  // Why local only: a remote host's filesystem is not this process's to stat.
  const locationPresence = local
    ? await within(() => presenceOf(locationPath, 'directory', deps))
    : 'unknown'

  const startupCwdByTabId: Record<string, WorkingSetFactPresence> = {}
  const panes: Record<string, WorkingSetPaneRestoreFacts> = {}
  // Why sequential: a stalled mount should cost one bounded probe at a time, not a fan-out.
  for (const entry of manifest.entries) {
    if (entry.startupCwd !== null) {
      const cwd = entry.startupCwd
      startupCwdByTabId[entry.tabId] = local
        ? await within(() => presenceOf(cwd, 'directory', deps))
        : 'unknown'
    }
    for (const pane of entry.panes) {
      const scrollback = await within(() =>
        readSealedScrollbackPresence(root, scope, manifest.workingSetId, entry.tabId, pane.leafId)
      )
      const transcript =
        pane.resume.kind === 'provider-session'
          ? local
            ? await within(async () => (await transcriptPresence(pane, deps)) ?? 'unknown')
            : 'unknown'
          : null
      panes[`${entry.tabId}:${pane.leafId}`] = { sealedScrollback: scrollback, transcript }
    }
  }
  return { location: locationPresence, startupCwdByTabId, panes }
}
