import { readFile, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import {
  claudeTranscriptHomeRelativeDir,
  isTransferableClaudeSessionId
} from '../../shared/claude-session-transfer-path'
import type {
  WorkingSetSessionTransferFact,
  WorkingSetSessionTransferReason
} from '../../shared/project-working-set-session-transfer-types'
import type {
  ProjectWorkingSetManifest,
  WorkingSetPane
} from '../../shared/project-working-set-types'
import type { IFilesystemProvider } from '../providers/types'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'

/**
 * Makes each Claude pane of a continued working set resumable on the SSH target: its transcript is
 * copied from this host into the directory Claude reads for the pane's target cwd, then read back.
 * The write is exclusive, so a file already holding that id there is never replaced.
 */

export const MAX_TRANSFER_BYTES = 64 * 1024 * 1024
const CHUNK_BYTES = 4 * 1024 * 1024

type TargetFs = Pick<
  IFilesystemProvider,
  'stat' | 'createDir' | 'realpath' | 'readFile' | 'writeFileBase64Chunk'
>

export type SessionTransferDeps = {
  target: TargetFs
  readLocal: (path: string) => Promise<Buffer>
  localFileSize: (path: string) => Promise<number | null>
  findTranscript: (sessionId: string) => Promise<string | null>
}

export const defaultLocalTransferDeps: Omit<SessionTransferDeps, 'target'> = {
  readLocal: (path) => readFile(path),
  localFileSize: async (path) => {
    try {
      const info = await stat(path)
      return info.isFile() ? info.size : null
    } catch {
      return null
    }
  },
  findTranscript: (sessionId) => resolveSessionFilePath('claude', sessionId)
}

function fact(
  reason: WorkingSetSessionTransferReason,
  transcript: 'present' | 'unknown' = 'unknown'
): WorkingSetSessionTransferFact {
  return { transcript, reason }
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || /ENOENT|no such file/i.test(String((error as Error)?.message ?? ''))
}

async function sourcePath(pane: WorkingSetPane, deps: SessionTransferDeps): Promise<string | null> {
  if (pane.resume.kind !== 'provider-session') {
    return null
  }
  const recorded = pane.resume.providerSession.transcriptPath
  if (recorded && isAbsolute(recorded) && (await deps.localFileSize(recorded)) !== null) {
    return recorded
  }
  return deps.findTranscript(pane.resume.providerSession.id)
}

async function writeExclusive(target: TargetFs, file: string, bytes: Buffer): Promise<void> {
  // Why the first chunk is not an append: it is the exclusive create that refuses an existing file.
  for (let offset = 0; offset === 0 || offset < bytes.length; offset += CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, offset + CHUNK_BYTES)
    await target.writeFileBase64Chunk(file, chunk.toString('base64'), offset > 0)
  }
}

async function transferOne(
  pane: WorkingSetPane,
  cwd: string | undefined,
  deps: SessionTransferDeps
): Promise<WorkingSetSessionTransferFact> {
  if (
    pane.resume.kind !== 'provider-session' ||
    pane.resume.agent !== 'claude' ||
    pane.resume.providerSession.key !== 'session_id'
  ) {
    return fact('not-transferable-agent')
  }
  const id = pane.resume.providerSession.id
  if (!isTransferableClaudeSessionId(id)) {
    return fact('invalid-session-id')
  }
  const homeDir = cwd ? claudeTranscriptHomeRelativeDir(cwd) : null
  if (!cwd || !homeDir) {
    return fact('no-target-cwd')
  }
  const source = await sourcePath(pane, deps)
  const size = source ? await deps.localFileSize(source) : null
  if (!source || size === null) {
    return fact('source-missing')
  }
  if (size > MAX_TRANSFER_BYTES) {
    return fact('source-too-large')
  }
  const bytes = await deps.readLocal(source)
  const { target } = deps
  try {
    const cwdInfo = await target.stat(cwd)
    if (cwdInfo.type !== 'directory') {
      return fact('target-cwd-missing')
    }
  } catch (error) {
    return fact(isMissing(error) ? 'target-cwd-missing' : 'target-unreachable')
  }
  let file: string
  try {
    await target.createDir(homeDir)
    // Why realpath: the binary write goes over SFTP, which does not expand `~`.
    file = `${(await target.realpath(homeDir)).replace(/\/+$/, '')}/${id}.jsonl`
  } catch {
    return fact('target-unreachable')
  }
  try {
    const existing = await target.stat(file)
    if (existing.size !== bytes.length) {
      return fact('target-conflict')
    }
    const read = await target.readFile(file, { maxTextBytes: MAX_TRANSFER_BYTES })
    return !read.isBinary && Buffer.from(read.content, 'utf8').equals(bytes)
      ? fact('already-present', 'present')
      : fact('target-conflict')
  } catch (error) {
    if (!isMissing(error)) {
      return fact('target-unreachable')
    }
  }
  try {
    await writeExclusive(target, file, bytes)
  } catch {
    // Why not retried as an overwrite: the exclusive create also loses to a file that appeared meanwhile.
    return fact('write-failed')
  }
  try {
    return (await target.stat(file)).size === bytes.length
      ? fact('copied', 'present')
      : fact('verify-failed')
  } catch {
    return fact('verify-failed')
  }
}

/** Keyed `${tabId}:${leafId}`; one entry per pane that carries a provider session. */
export async function transferContinueSessions(
  manifest: ProjectWorkingSetManifest,
  cwdByPaneKey: Record<string, string>,
  deps: SessionTransferDeps
): Promise<Record<string, WorkingSetSessionTransferFact>> {
  const out: Record<string, WorkingSetSessionTransferFact> = {}
  // Why sequential: one SSH channel, and a stalled host should cost one bounded step at a time.
  for (const entry of manifest.entries) {
    for (const pane of entry.panes) {
      if (pane.resume.kind !== 'provider-session') {
        continue
      }
      const key = `${entry.tabId}:${pane.leafId}`
      try {
        out[key] = await transferOne(pane, cwdByPaneKey[key], deps)
      } catch {
        out[key] = fact('source-missing')
      }
    }
  }
  return out
}
