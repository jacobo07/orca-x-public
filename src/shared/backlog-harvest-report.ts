import type { BacklogStorageStage } from './backlog-outcomes'

export const BACKLOG_HARVEST_UNITS = [
  'orca-conversations',
  'agent-transcripts',
  'chatgpt-export'
] as const
export type BacklogHarvestUnit = (typeof BACKLOG_HARVEST_UNITS)[number]

// Units a runtime RPC caller may run; the export needs a desktop dialog, so it never is (R-05).
export const BACKLOG_HARVEST_RPC_UNITS = ['orca-conversations', 'agent-transcripts'] as const
export type BacklogHarvestRpcUnit = (typeof BACKLOG_HARVEST_RPC_UNITS)[number]

export const BACKLOG_HARVEST_SKIP_REASONS = [
  'unreadable',
  'schema-too-new',
  'vanished',
  'turn-unsettled',
  'no-user-text',
  'too-short',
  'text-too-long',
  'markers-over-limit',
  'transcript-too-large',
  'subagent',
  'missing-id',
  'missing-mapping',
  'broken-thread',
  'not-an-object'
] as const
export type BacklogHarvestSkipReason = (typeof BACKLOG_HARVEST_SKIP_REASONS)[number]

export const BACKLOG_HARVEST_REFUSAL_CODES = [
  'source-unreadable',
  'already-running',
  'not-json',
  'not-an-export',
  'too-large',
  'read-failed',
  'not-a-file'
] as const
export type BacklogHarvestRefusalCode = (typeof BACKLOG_HARVEST_REFUSAL_CODES)[number]

export const BACKLOG_HARVEST_CAPS = ['sources-per-run', 'candidates-per-run'] as const
export type BacklogHarvestCap = (typeof BACKLOG_HARVEST_CAPS)[number]

export type BacklogHarvestKeptOrder = 'newest' | 'first-by-id' | 'first-in-file'

/** No cursor: a second run reads the same kept set, so nothing here promises a later run continues. */
export type BacklogHarvestCapHit = {
  code: BacklogHarvestCap
  notScanned: number
  kept: BacklogHarvestKeptOrder
}

export type BacklogHarvestSkipCounts = Partial<Record<BacklogHarvestSkipReason, number>>

/**
 * One run's answer. Counts and closed codes only: never candidate text, a title, a path or a
 * file name, because it crosses the remote wire (P-02).
 */
export type BacklogHarvestRunReport =
  | {
      outcome: 'completed'
      unit: BacklogHarvestUnit
      startedAt: number
      finishedAt: number
      seen: number
      read: number
      candidatesNew: number
      candidatesDuplicate: number
      candidatesFailed: Record<string, number>
      skipped: BacklogHarvestSkipCounts
      unsupported?: number
      cap: BacklogHarvestCapHit | null
    }
  | {
      outcome: 'refused'
      unit: BacklogHarvestUnit
      code: BacklogHarvestRefusalCode
      finishedAt: number
    }
  | {
      outcome: 'failed'
      unit: BacklogHarvestUnit
      stage: BacklogStorageStage
      code: string | null
      startedAt: number
      finishedAt: number
      seen: number
      read: number
      candidatesNew: number
      candidatesDuplicate: number
      skipped: BacklogHarvestSkipCounts
    }
