import { stat } from 'node:fs/promises'
import { parseExecutionHostId } from '../../shared/execution-host'
import { probeAgentTranscriptPresence } from '../native-chat/agent-transcript-presence'
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
  // One primitive answers this for every transition that asks it. This adapter shapes the subject
  // and keeps the manifest-shaped deps this probe's own tests inject.
  return probeAgentTranscriptPresence(
    {
      agent: providerPane.resume.agent,
      sessionId: providerPane.resume.providerSession.id,
      ...(providerPane.resume.providerSession.transcriptPath
        ? { transcriptPath: providerPane.resume.providerSession.transcriptPath }
        : {})
    },
    {
      statPath: deps.statPath,
      hostReadableTranscript: deps.hostReadableTranscript,
      findTranscript: () => deps.findTranscript(providerPane),
      platform: deps.platform
    }
  )
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
