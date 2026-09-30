import type {
  BacklogHarvestRpcUnit,
  BacklogHarvestRunReport,
  BacklogHarvestUnit
} from '../../../shared/backlog-harvest-report'
import type { HarvestIngestPort, HarvestUnitResult } from './harvest-ingest-pipeline'
import {
  harvestOrcaConversations,
  type BacklogConversationSource
} from './orca-conversation-harvest'

/** Resolved per run, so a profile switch applies to the next run. */
export type BacklogHarvestSources = {
  conversations: () => BacklogConversationSource
}

export type BacklogHarvestRunner = {
  run: (unit: BacklogHarvestRpcUnit) => Promise<BacklogHarvestRunReport>
}

function reportOf(
  unit: BacklogHarvestUnit,
  result: HarvestUnitResult,
  startedAt: number,
  finishedAt: number
): BacklogHarvestRunReport {
  if (result.outcome === 'refused') {
    return { outcome: 'refused', unit, code: result.code, finishedAt }
  }
  const { tally, seen, read, skipped } = result
  if (tally.halted !== null) {
    return {
      outcome: 'failed',
      unit,
      stage: tally.halted.stage,
      code: tally.halted.code,
      startedAt,
      finishedAt,
      seen,
      read,
      candidatesNew: tally.candidatesNew,
      candidatesDuplicate: tally.candidatesDuplicate,
      skipped
    }
  }
  return {
    outcome: 'completed',
    unit,
    startedAt,
    finishedAt,
    seen,
    read,
    candidatesNew: tally.candidatesNew,
    candidatesDuplicate: tally.candidatesDuplicate,
    candidatesFailed: tally.candidatesFailed,
    skipped,
    cap: result.cap
  }
}

/** The one entry every harvest unit runs through. */
export function createBacklogHarvestRunner(options: {
  service: HarvestIngestPort
  sources: BacklogHarvestSources
  now?: () => number
}): BacklogHarvestRunner {
  const now = options.now ?? Date.now
  return {
    run: async (unit) => {
      const startedAt = now()
      const result = await harvestOrcaConversations(
        options.sources.conversations(),
        options.service
      )
      return reportOf(unit, result, startedAt, now())
    }
  }
}
