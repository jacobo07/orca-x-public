import type {
  BacklogHarvestRpcUnit,
  BacklogHarvestRunReport,
  BacklogHarvestStatusReport,
  BacklogHarvestUnit
} from '../../../shared/backlog-harvest-report'
import {
  harvestAiVaultTranscripts,
  type BacklogTranscriptSource
} from './ai-vault-transcript-harvest'
import { importChatGptExportFile } from './chatgpt-export-import'
import type { HarvestIngestPort, HarvestUnitResult } from './harvest-ingest-pipeline'
import { HarvestRunRegistry } from './harvest-run-registry'
import {
  harvestOrcaConversations,
  type BacklogConversationSource
} from './orca-conversation-harvest'

/** Resolved per run, so a profile switch applies to the next run. */
export type BacklogHarvestSources = {
  conversations: () => BacklogConversationSource
  transcripts: () => BacklogTranscriptSource
}

function harvestUnit(
  unit: BacklogHarvestRpcUnit,
  sources: BacklogHarvestSources,
  service: HarvestIngestPort
): Promise<HarvestUnitResult> {
  switch (unit) {
    case 'orca-conversations':
      return harvestOrcaConversations(sources.conversations(), service)
    case 'agent-transcripts':
      return harvestAiVaultTranscripts(sources.transcripts(), service)
  }
}

export type BacklogHarvestRunner = {
  run: (unit: BacklogHarvestRpcUnit) => Promise<BacklogHarvestRunReport>
  /** The export import (03-05): its reader is the caller's, the single flight and status are ours. */
  runImport: (work: () => Promise<HarvestUnitResult>) => Promise<BacklogHarvestRunReport>
  /** One user-picked ChatGPT export, under the same single flight and status as every unit. */
  importChatGptExport: (filePath: string) => Promise<BacklogHarvestRunReport>
  status: () => Promise<BacklogHarvestStatusReport>
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
    ...(result.unsupported === undefined ? {} : { unsupported: result.unsupported }),
    cap: result.cap
  }
}

/** The one entry every harvest unit runs through. */
export function createBacklogHarvestRunner(options: {
  service: HarvestIngestPort
  sources: BacklogHarvestSources
  /** The same resolver the ledger uses, so status follows a profile switch. */
  ledgerRoot: () => string
  now?: () => number
}): BacklogHarvestRunner {
  const now = options.now ?? Date.now
  const registry = new HarvestRunRegistry()

  const track = async (
    unit: BacklogHarvestUnit,
    work: () => Promise<HarvestUnitResult>
  ): Promise<BacklogHarvestRunReport> => {
    const root = options.ledgerRoot()
    if (!registry.begin(root, unit)) {
      return { outcome: 'refused', unit, code: 'already-running', finishedAt: now() }
    }
    const startedAt = now()
    let report: BacklogHarvestRunReport
    try {
      report = reportOf(unit, await work(), startedAt, now())
    } catch {
      // Every throw lands here, so the finish below always runs and a unit never sticks at running.
      report = {
        outcome: 'failed',
        unit,
        stage: 'harvest',
        code: 'unexpected',
        startedAt,
        finishedAt: now()
      }
    }
    registry.finish(root, unit, report)
    return report
  }

  return {
    run: (unit) => track(unit, () => harvestUnit(unit, options.sources, options.service)),
    runImport: (work) => track('chatgpt-export', work),
    importChatGptExport: (filePath) =>
      track('chatgpt-export', () =>
        importChatGptExportFile(filePath, { service: options.service, now })
      ),
    status: async () => registry.statusFor(options.ledgerRoot())
  }
}
