import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { WorkingSetFactPresence } from '../../shared/project-working-set-store-types'
import type { AgentType } from '../../shared/native-chat-types'
import { toHostReadableTranscriptPath } from './host-readable-transcript-path'
import { resolveSessionFilePath } from './session-file-resolver'

/**
 * Was this agent conversation actually FOUND on disk.
 *
 * The answer is three-valued and the third value is the point: `absent` requires the filesystem to
 * have said so, and everything else — a search that merely found nothing, a stopped WSL distro, a
 * stalled mount, a path this process cannot read — is `unknown`. A session may live under another
 * account's config directory, so a miss is not proof of a deletion.
 *
 * This was reachable in exactly one place before: inside the probe that reads a SEALED working-set
 * manifest. A live pane could not ask it, which is why sleeping a workspace recorded a resume
 * handle and no verdict about whether that handle still led anywhere.
 */

export type AgentTranscriptSubject = {
  agent: AgentType
  sessionId: string
  /** The path the agent's own hook reported, when there was one. A claim, not an observation. */
  transcriptPath?: string
}

export type AgentTranscriptPresenceDeps = {
  statPath: (path: string) => Promise<{ isFile: () => boolean }>
  hostReadableTranscript: (path: string) => Promise<string | null>
  findTranscript: (subject: AgentTranscriptSubject) => Promise<string | null>
  platform: NodeJS.Platform
}

export const defaultAgentTranscriptPresenceDeps: AgentTranscriptPresenceDeps = {
  statPath: (path) => stat(path),
  hostReadableTranscript: (path) => toHostReadableTranscriptPath(path),
  findTranscript: (subject) =>
    resolveSessionFilePath(subject.agent, subject.sessionId, {
      ...(subject.transcriptPath ? { transcriptPath: subject.transcriptPath } : {})
    }),
  platform: process.platform
}

function errorCode(error: unknown): string | null {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' ? code : null
}

async function filePresence(
  path: string,
  deps: AgentTranscriptPresenceDeps
): Promise<WorkingSetFactPresence> {
  try {
    return (await deps.statPath(path)).isFile() ? 'present' : 'unknown'
  } catch (error) {
    const code = errorCode(error)
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unknown'
  }
}

export async function probeAgentTranscriptPresence(
  subject: AgentTranscriptSubject,
  deps: AgentTranscriptPresenceDeps = defaultAgentTranscriptPresenceDeps
): Promise<WorkingSetFactPresence> {
  const recorded = subject.transcriptPath
  // Why only a native absolute path can prove absence: a WSL guest path on Windows goes through
  // distro probing, where "not found" also covers a stopped distro.
  const wslGuest = deps.platform === 'win32' && recorded?.startsWith('/')
  if (recorded && isAbsolute(recorded) && !wslGuest) {
    return filePresence(recorded, deps)
  }
  if (recorded) {
    return (await deps.hostReadableTranscript(recorded)) ? 'present' : 'unknown'
  }
  return (await deps.findTranscript(subject)) ? 'present' : 'unknown'
}

/** Bounds a probe so a stalled mount costs a timeout rather than a hung transition. */
export async function boundedTranscriptPresence(
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
