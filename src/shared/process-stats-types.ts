// ─── Stats ──────────────────────────────────────────────────────────

export type StatsSummary = {
  totalAgentsSpawned: number
  totalPRsCreated: number
  totalAgentTimeMs: number
  // Sourced from aggregates, not the event log, so it survives event trimming.
  firstEventAt: number | null // timestamp of first-ever event, for "tracking since..."
}

// ─── Memory dashboard ──────────────────────────────────────────────

/** cpu is percent of a single core — can exceed 100 on multi-core. memory is in bytes. */
export type UsageValues = {
  cpu: number
  memory: number
}

export type ProcessMemoryMetric = 'rss' | 'working-set'

export type HostAvailableMemorySource = 'memory-pressure' | 'proc-meminfo' | 'free-memory'

/** The top-level cpu/memory are the sum of main + renderer + other + terminalHost. */
export type AppMemory = UsageValues & {
  main: UsageValues
  renderer: UsageValues
  other: UsageValues
  /** The terminal daemon process itself; it is detached, so Electron's metrics never list it. Absent from older hosts. */
  terminalHost?: UsageValues
  /** Oldest-first memory samples (bytes) for the whole Orca app; empty before the first snapshot. */
  history: number[]
}

export type SessionMemory = UsageValues & {
  sessionId: string
  paneKey: string | null
  pid: number
  /** The processes this session claimed in this sweep, with their bytes. Absent from older hosts. */
  processes?: ProcessMemorySample[]
}

export type ProcessMemorySample = { pid: number; memory: number }

/** The top-level cpu/memory are the sum of sessions. */
export type WorktreeMemory = UsageValues & {
  worktreeId: string
  worktreeName: string
  repoId: string
  repoName: string
  sessions: SessionMemory[]
  /** Oldest-first memory samples (bytes) for this worktree's tracked subtrees. */
  history: number[]
}

export type HostMemory = {
  totalMemory: number
  /** Immediately free memory reported by Node's host API. */
  freeMemory: number
  /** Memory available without material pressure, or freeMemory when unavailable. */
  availableMemory: number
  availableMemorySource: HostAvailableMemorySource
  /** totalMemory - availableMemory. */
  usedMemory: number
  memoryUsagePercent: number
  cpuCoreCount: number
  loadAverage1m: number
}

export type MemorySnapshot = {
  app: AppMemory
  worktrees: WorktreeMemory[]
  host: HostMemory
  /** Per-process byte metric used by app, session, worktree, history, and totalMemory values. */
  processMemoryMetric: ProcessMemoryMetric
  /** Sum of app + all tracked worktree sessions. Percent of a single core, so may exceed 100 on multi-core machines. */
  totalCpu: number
  /** Sum of per-process samples. Shared pages may repeat, so this can exceed host.totalMemory. */
  totalMemory: number
  /**
   * Daemon descendants no registered PTY claimed (ConPTY hosts, sessions without a published pid).
   * Counted in totalMemory but not in app: the owner cannot be named. Absent from older hosts.
   */
  terminalHostDescendants?: UsageValues
  /** 'failed' when the host process sweep returned nothing, so every per-process value is unmeasured, not zero. */
  processSweep?: ProcessSweepOutcome
  /** When the process table read began. collectedAt is stamped after it, and merged callers share one sweep. */
  sweepStartedAt?: number
  collectedAt: number
}

export type ProcessSweepOutcome = 'measured' | 'failed'

/**
 * Which of the asked pids a fresh host sweep still lists. Only 'measured' says
 * anything: a failed sweep lists nothing, and that is not every process gone.
 */
export type ProcessPresenceProbe =
  | {
      sweep: 'measured'
      sweepStartedAt: number
      metric: ProcessMemoryMetric
      presentPids: number[]
    }
  | { sweep: 'failed'; sweepStartedAt: number }
