import {
  BACKLOG_HARVEST_UNITS,
  type BacklogHarvestRunReport,
  type BacklogHarvestRunStatus,
  type BacklogHarvestStatusReport,
  type BacklogHarvestUnit
} from '../../../shared/backlog-harvest-report'

type UnitRun = { running: boolean; lastReport: BacklogHarvestRunReport | null }

function statusOf(run: UnitRun | undefined): BacklogHarvestRunStatus {
  if (run === undefined) {
    return 'not-run'
  }
  if (run.running) {
    return 'running'
  }
  // Connected comes only from a finished run of this process, never from what the ledger holds.
  switch (run.lastReport?.outcome) {
    case 'completed':
      return 'connected'
    case 'refused':
      return 'refused'
    case 'failed':
      return 'failed'
    default:
      return 'not-run'
  }
}

/**
 * Last run per (ledger root, unit) plus per-unit single flight. In memory only: no timer, no
 * persistence, so a restart and a profile switch both read 'not-run' (D-19, P-07).
 */
export class HarvestRunRegistry {
  private readonly byRoot = new Map<string, Map<BacklogHarvestUnit, UnitRun>>()

  private runsOf(root: string): Map<BacklogHarvestUnit, UnitRun> {
    let runs = this.byRoot.get(root)
    if (runs === undefined) {
      runs = new Map()
      this.byRoot.set(root, runs)
    }
    return runs
  }

  /** False when that unit is already running under this root; the caller must not start it. */
  begin(root: string, unit: BacklogHarvestUnit): boolean {
    const runs = this.runsOf(root)
    const run = runs.get(unit)
    if (run?.running) {
      return false
    }
    runs.set(unit, { running: true, lastReport: run?.lastReport ?? null })
    return true
  }

  finish(root: string, unit: BacklogHarvestUnit, report: BacklogHarvestRunReport): void {
    this.runsOf(root).set(unit, { running: false, lastReport: report })
  }

  statusFor(root: string): BacklogHarvestStatusReport {
    const runs = this.byRoot.get(root)
    return {
      units: BACKLOG_HARVEST_UNITS.map((unit) => {
        const run = runs?.get(unit)
        return { unit, status: statusOf(run), lastReport: run?.lastReport ?? null }
      })
    }
  }
}
