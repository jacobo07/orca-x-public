import { lstat, readFile } from 'node:fs/promises'

import { BACKLOG_HARVEST_EXPORT_BYTES_MAX } from '../../../shared/backlog-harvest-limits'
import type {
  BacklogHarvestSkipCounts,
  BacklogHarvestSkipReason
} from '../../../shared/backlog-harvest-report'
import type { BacklogCandidateIngestEntry } from '../backlog-candidate-operations'
import { deriveHarvestFingerprint } from './candidate-fingerprint'
import { parseChatGptExport, type ParsedChatGptConversation } from './chatgpt-export-parse'
import { extractConversationIntents } from './conversation-intent-extraction'
import {
  ingestHarvestedCandidates,
  type HarvestIngestPort,
  type HarvestUnitResult
} from './harvest-ingest-pipeline'

export const CHATGPT_EXPORT_IMPORT_ADAPTER = 'chatgpt-export-import.v1'

type ExportFileAccess = {
  lstat: (
    filePath: string
  ) => Promise<{ isFile: () => boolean; isSymbolicLink: () => boolean; size: number }>
  readFile: (filePath: string, encoding: 'utf8') => Promise<string>
}

export type ChatGptExportImportDeps = {
  service: HarvestIngestPort
  now: () => number
  /** Test seam over the two reads; production uses node:fs/promises. */
  fs?: ExportFileAccess
  /** Test seam that can only matter below the real cap, so a TOCTOU case needs no 128 MiB string. */
  bytesMax?: number
}

function entriesOf(
  conversation: ParsedChatGptConversation,
  skipped: BacklogHarvestSkipCounts,
  now: () => number
): BacklogCandidateIngestEntry[] {
  // A historical export has no turn in flight, so an unanswered last ask is a settled one.
  const extraction = extractConversationIntents(conversation.messages, {
    lastTurnState: 'settled'
  })
  for (const [reason, count] of Object.entries(extraction.skipped)) {
    const key = reason as BacklogHarvestSkipReason
    skipped[key] = (skipped[key] ?? 0) + (count ?? 0)
  }
  return extraction.intents.map((intent): BacklogCandidateIngestEntry => {
    const lineSuffix = intent.lineIndex === null ? '' : `#L${intent.lineIndex}`
    const ref = `${conversation.id}#${intent.messageId}${lineSuffix}`
    return {
      source: {
        kind: 'chatgpt-export',
        ref,
        capturedAt: intent.capturedAt ?? conversation.updatedAt ?? now(),
        adapter: CHATGPT_EXPORT_IMPORT_ADAPTER,
        // Bounded by the export date (D-12).
        capabilityLevel: 'bounded'
      },
      fingerprint: deriveHarvestFingerprint('chatgpt-export', ref, intent.text),
      text: intent.text,
      uncertainty: intent.uncertainty,
      projectHint: null
    }
  })
}

/**
 * Imports one user-picked export (D-10): read into memory, parsed, dropped. Nothing is copied or
 * written except the candidate records the ingest publishes. UNVERIFIED-ON-REAL-EXPORT (D-13).
 */
export async function importChatGptExportFile(
  filePath: string,
  deps: ChatGptExportImportDeps
): Promise<HarvestUnitResult> {
  const fs = deps.fs ?? { lstat, readFile }
  const bytesMax = Math.min(
    deps.bytesMax ?? BACKLOG_HARVEST_EXPORT_BYTES_MAX,
    BACKLOG_HARVEST_EXPORT_BYTES_MAX
  )
  let stats: Awaited<ReturnType<ExportFileAccess['lstat']>>
  try {
    stats = await fs.lstat(filePath)
  } catch {
    return { outcome: 'refused', code: 'read-failed' }
  }
  // lstat, not stat: a symlink is refused rather than followed to whatever it names.
  if (stats.isSymbolicLink() || !stats.isFile()) {
    return { outcome: 'refused', code: 'not-a-file' }
  }
  if (stats.size > bytesMax) {
    return { outcome: 'refused', code: 'too-large' }
  }
  let text: string
  try {
    text = await fs.readFile(filePath, 'utf8')
  } catch {
    return { outcome: 'refused', code: 'read-failed' }
  }
  // The file may have grown between the lstat and the read.
  if (Buffer.byteLength(text, 'utf8') > bytesMax) {
    return { outcome: 'refused', code: 'too-large' }
  }
  const parsed = parseChatGptExport(text.startsWith('﻿') ? text.slice(1) : text)
  if (parsed.outcome === 'refused') {
    return { outcome: 'refused', code: parsed.code }
  }
  const skipped: BacklogHarvestSkipCounts = { ...parsed.skipped }
  const entries = parsed.conversations.flatMap((conversation) =>
    entriesOf(conversation, skipped, deps.now)
  )
  const tally = await ingestHarvestedCandidates(deps.service, entries, 'first-in-file')
  return {
    outcome: 'scanned',
    seen: parsed.seen,
    read: parsed.conversations.length,
    skipped,
    cap: parsed.cap ?? tally.cap,
    tally
  }
}
