import type { AiVaultListResult, AiVaultSession } from '../../../shared/ai-vault-types'
import {
  BACKLOG_HARVEST_TRANSCRIPT_BYTES_MAX,
  BACKLOG_HARVEST_TRANSCRIPTS_PER_RUN
} from '../../../shared/backlog-harvest-limits'
import type {
  BacklogHarvestCapHit,
  BacklogHarvestSkipCounts,
  BacklogHarvestSkipReason
} from '../../../shared/backlog-harvest-report'
import type { BacklogSourceKind } from '../../../shared/backlog-types'
import type { NativeChatMessage, NativeChatTurnLifecycle } from '../../../shared/native-chat-types'
import type { ReadTranscriptResult } from '../../native-chat/transcript-reader'
import type { BacklogCandidateIngestEntry } from '../backlog-candidate-operations'
import { deriveHarvestFingerprint } from './candidate-fingerprint'
import { extractConversationIntents, type LastTurnState } from './conversation-intent-extraction'
import {
  ingestHarvestedCandidates,
  type HarvestIngestPort,
  type HarvestUnitResult
} from './harvest-ingest-pipeline'

export const AI_VAULT_TRANSCRIPT_HARVEST_ADAPTER = 'ai-vault-transcript-harvest.v1'

/** The providers whose transcripts this harvester can decode; every other AI Vault agent is unsupported. */
export type HarvestedTranscriptProvider = 'claude' | 'codex'

const SOURCE_KIND: Record<HarvestedTranscriptProvider, BacklogSourceKind> = {
  claude: 'claude-code-transcript',
  codex: 'codex-transcript'
}

/** Read-only port over this host's AI Vault; the harvester never writes a transcript. */
export type BacklogTranscriptSource = {
  list: () => Promise<AiVaultListResult>
  statBytes: (filePath: string) => Promise<number>
  readTranscript: (
    provider: HarvestedTranscriptProvider,
    sessionId: string,
    filePath: string
  ) => Promise<ReadTranscriptResult>
}

type SupportedRow = { row: AiVaultSession; provider: HarvestedTranscriptProvider; time: number }

function addSkip(skipped: BacklogHarvestSkipCounts, reason: BacklogHarvestSkipReason, count = 1) {
  skipped[reason] = (skipped[reason] ?? 0) + count
}

function providerOf(row: AiVaultSession): HarvestedTranscriptProvider | null {
  return row.agent === 'claude' || row.agent === 'codex' ? row.agent : null
}

function lastTurnStateOf(lifecycle: NativeChatTurnLifecycle | undefined): LastTurnState {
  if (lifecycle === undefined) {
    return 'unknown'
  }
  return lifecycle.state === 'working' ? 'unsettled' : 'settled'
}

// The reader's position id embeds the absolute file path; a ref crosses the remote wire (T-03-08).
function messageKeyOf(messageId: string, filePath: string): string {
  const prefix = `${filePath}:`
  return messageId.startsWith(prefix) ? `pos-${messageId.slice(prefix.length)}` : messageId
}

function entriesOf(
  supported: SupportedRow,
  messages: NativeChatMessage[],
  lifecycle: NativeChatTurnLifecycle | undefined,
  skipped: BacklogHarvestSkipCounts
): BacklogCandidateIngestEntry[] {
  const { row, provider, time } = supported
  const extraction = extractConversationIntents(messages, {
    lastTurnState: lastTurnStateOf(lifecycle)
  })
  for (const [reason, count] of Object.entries(extraction.skipped)) {
    addSkip(skipped, reason as BacklogHarvestSkipReason, count ?? 0)
  }
  const kind = SOURCE_KIND[provider]
  return extraction.intents.map((intent): BacklogCandidateIngestEntry => {
    const lineSuffix = intent.lineIndex === null ? '' : `#L${intent.lineIndex}`
    const ref = `${provider}:${row.sessionId}#${messageKeyOf(intent.messageId, row.filePath)}${lineSuffix}`
    return {
      source: {
        kind,
        ref,
        capturedAt: intent.capturedAt ?? time,
        adapter: AI_VAULT_TRANSCRIPT_HARVEST_ADAPTER,
        capabilityLevel: 'full'
      },
      fingerprint: deriveHarvestFingerprint(kind, ref, intent.text),
      text: intent.text,
      uncertainty: intent.uncertainty,
      // A cwd is a path, never evidence the harvester may send; the human maps the project.
      projectHint: null
    }
  })
}

/** Filters to readable providers BEFORE the cap, so foreign rows can never crowd one out (B-1). */
function partition(listed: AiVaultListResult, skipped: BacklogHarvestSkipCounts) {
  const supported: SupportedRow[] = []
  let unsupported = 0
  for (const row of listed.sessions) {
    const provider = providerOf(row)
    const time = Date.parse(row.modifiedAt)
    if (provider === null) {
      unsupported += 1
    } else if (row.subagent !== null) {
      addSkip(skipped, 'subagent')
    } else if (!Number.isFinite(time)) {
      addSkip(skipped, 'unreadable')
    } else {
      supported.push({ row, provider, time })
    }
  }
  // Scanner commentary is not a failure; every other issue is a source this run could not read.
  const failures = listed.issues.filter((issue) => issue.kind !== 'notice').length
  if (failures > 0) {
    addSkip(skipped, 'unreadable', failures)
  }
  supported.sort((a, b) => b.time - a.time)
  return { supported, unsupported }
}

/**
 * Harvests this host's local Claude Code and Codex transcripts. No host check: the AI Vault scan is
 * host-local by construction, and a remote Orca server harvests its own stores (R-04).
 */
export async function harvestAiVaultTranscripts(
  source: BacklogTranscriptSource,
  port: HarvestIngestPort
): Promise<HarvestUnitResult> {
  let listed: AiVaultListResult
  try {
    listed = await source.list()
  } catch {
    return { outcome: 'refused', code: 'source-unreadable' }
  }
  const skipped: BacklogHarvestSkipCounts = {}
  const { supported, unsupported } = partition(listed, skipped)
  const kept = supported.slice(0, BACKLOG_HARVEST_TRANSCRIPTS_PER_RUN)
  const sourcesCap: BacklogHarvestCapHit | null =
    supported.length > kept.length
      ? { code: 'sources-per-run', notScanned: supported.length - kept.length, kept: 'newest' }
      : null
  const entries: BacklogCandidateIngestEntry[] = []
  let read = 0
  // One at a time: each transcript is decoded whole in memory.
  for (const candidate of kept) {
    const { row, provider } = candidate
    let bytes: number
    try {
      bytes = await source.statBytes(row.filePath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      addSkip(skipped, code === 'ENOENT' ? 'vanished' : 'unreadable')
      continue
    }
    if (bytes > BACKLOG_HARVEST_TRANSCRIPT_BYTES_MAX) {
      addSkip(skipped, 'transcript-too-large')
      continue
    }
    let result: ReadTranscriptResult
    try {
      result = await source.readTranscript(provider, row.sessionId, row.filePath)
    } catch {
      result = { error: 'read threw' }
    }
    if ('error' in result) {
      addSkip(skipped, result.notFound ? 'vanished' : 'unreadable')
      continue
    }
    read += 1
    entries.push(...entriesOf(candidate, result.messages, result.lifecycle, skipped))
  }
  const tally = await ingestHarvestedCandidates(port, entries, 'newest')
  const cap = sourcesCap ?? tally.cap
  return {
    outcome: 'scanned',
    seen: listed.sessions.length,
    read,
    skipped,
    unsupported,
    cap,
    tally
  }
}
