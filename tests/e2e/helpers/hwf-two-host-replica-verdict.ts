// Pure verdicts for the two-host replica legs: a leg passes only when its protection is visible in the output.

export type LegVerdict = { verdict: 'PASS' | 'FAIL' | 'NOT_RUN'; cause: string }

const pass = (cause: string): LegVerdict => ({ verdict: 'PASS', cause })
const fail = (cause: string): LegVerdict => ({ verdict: 'FAIL', cause })

/** A leg whose gate was absent: reported as NOT_RUN, never as a pass. */
export function notRunVerdict(reason: string): LegVerdict {
  return { verdict: 'NOT_RUN', cause: reason }
}

export function requirePass(leg: string, v: LegVerdict): void {
  if (v.verdict !== 'PASS') {
    throw new Error(`${leg}: ${v.verdict} - ${v.cause}`)
  }
}

export function summarizeLegs(legs: Record<string, LegVerdict>): {
  passed: number
  failed: number
  notRun: number
  overall: LegVerdict['verdict']
} {
  const all = Object.values(legs)
  const passed = all.filter((v) => v.verdict === 'PASS').length
  const failed = all.filter((v) => v.verdict === 'FAIL').length
  const notRun = all.length - passed - failed
  // Why: nothing run, or any leg skipped, is not a pass.
  const overall = failed > 0 ? 'FAIL' : notRun > 0 || passed === 0 ? 'NOT_RUN' : 'PASS'
  return { passed, failed, notRun, overall }
}

export const RELAY_TOO_OLD_WORD = 'unverified (relay-too-old)'
export const WORKTREE_UNVERIFIED_WORD = 'unverified (worktree-not-verified-clean)'

const PAIR_LINE = /^(\S+) {2}(\S+) {2}(.+)$/
const KNOWN_WORD = /^(same|unrelated|ahead \d+|behind \d+|diverged \+\d+\/-\d+)$/
const UNVERIFIED_WORD = /^unverified \([a-z-]+\)$/

type PairLine = { setupId: string; word: string }

function pairLines(output: string): PairLine[] {
  const lines: PairLine[] = []
  for (const line of output.split('\n')) {
    const m = PAIR_LINE.exec(line.trimEnd())
    if (m) {
      lines.push({ setupId: m[1], word: m[3] })
    }
  }
  return lines
}

/** The relation word printed for one setup must equal `expectedWord`, with the exit status the printer gives that word. */
export function compareVerdict(input: {
  output: string
  status: number
  expectedWord: string
  setupId?: string
}): LegVerdict {
  const all = pairLines(input.output)
  if (all.length === 0) {
    return fail(
      `no setup line in the compare output: ${JSON.stringify(input.output.slice(0, 200))}`
    )
  }
  for (const line of all) {
    if (!KNOWN_WORD.test(line.word) && !UNVERIFIED_WORD.test(line.word)) {
      return fail(`unrecognized relation word ${JSON.stringify(line.word)}`)
    }
  }
  const named = input.setupId === undefined ? all : all.filter((l) => l.setupId === input.setupId)
  if (named.length !== 1) {
    return fail(
      input.setupId === undefined
        ? `${all.length} setup lines and no setup named; cannot tell which one is read`
        : `${named.length} lines for setup ${input.setupId}`
    )
  }
  if (named[0].word !== input.expectedWord) {
    return fail(
      `printed ${JSON.stringify(named[0].word)}, expected ${JSON.stringify(input.expectedWord)}`
    )
  }
  // Why: the printer exits 0 only when every pair is known.
  const impliedStatus = all.every((l) => KNOWN_WORD.test(l.word)) ? 0 : 1
  if (input.status !== impliedStatus) {
    return fail(`exit status ${input.status}, the printed words imply ${impliedStatus}`)
  }
  return pass(`printed ${JSON.stringify(input.expectedWord)} with exit ${input.status}`)
}

export type SyncExpectation = 'synced' | 'disk-full' | 'connection-lost'
type SyncKind = SyncExpectation | 'connection-changed'

// Why: stable fragments of the CLI sentences; the unit test proves them against the real printers.
const SYNC_FRAGMENTS: Record<SyncKind, RegExp> = {
  synced: /^synced [0-9a-f]+\.\.[0-9a-f]+;/m,
  'disk-full': /the local disk is full/,
  'connection-lost': /the connection to the host was lost/,
  'connection-changed': /the connection changed during the sync/
}

function syncKindsOf(output: string): SyncKind[] {
  return (Object.keys(SYNC_FRAGMENTS) as SyncKind[]).filter((kind) =>
    SYNC_FRAGMENTS[kind].test(output)
  )
}

/** The printed sentence must be exactly the expected kind (not another), with exit 0 for synced and 1 otherwise. */
export function syncVerdict(input: {
  output: string
  status: number
  expect: SyncExpectation
}): LegVerdict {
  if (input.output.trim() === '') {
    return fail('empty sync output')
  }
  const kinds = syncKindsOf(input.output)
  if (kinds.length !== 1 || kinds[0] !== input.expect) {
    return fail(
      `expected the ${input.expect} sentence, classified as [${kinds.join(', ') || 'none'}]: ${JSON.stringify(input.output.slice(0, 200))}`
    )
  }
  const wantStatus = input.expect === 'synced' ? 0 : 1
  if (input.status !== wantStatus) {
    return fail(`exit status ${input.status}, ${input.expect} implies ${wantStatus}`)
  }
  return pass(`${input.expect} sentence with exit ${input.status}`)
}

/** Counts read from the owning host's relay logs; `replicaFacts` is null when that count was not measured. */
export type RelayLogCounts = {
  logs: number
  methods: number
  syncOrFabric: number
  replicaFacts: number | null
}

function lastInteger(out: string): number | null {
  const last = out.trim().split('\n').pop()?.trim() ?? ''
  return /^\d+$/.test(last) ? Number(last) : null
}

/** Null (never zero) when any count is unreadable, so a failed ssh read cannot look like an empty log. */
export function parseRelayLogCounts(input: {
  controlOut: string
  syncFabricOut: string
  replicaFactsOut?: string
}): RelayLogCounts | null {
  const logs = /P23_RELAY_LOGS=(\d+)/.exec(input.controlOut)?.[1]
  const methods = /P23_RELAY_METHODS=(\d+)/.exec(input.controlOut)?.[1]
  const syncOrFabric = lastInteger(input.syncFabricOut)
  const replicaFacts =
    input.replicaFactsOut === undefined ? null : lastInteger(input.replicaFactsOut)
  if (logs === undefined || methods === undefined || syncOrFabric === null) {
    return null
  }
  if (input.replicaFactsOut !== undefined && replicaFacts === null) {
    return null
  }
  return { logs: Number(logs), methods: Number(methods), syncOrFabric, replicaFacts }
}

// Why: a zero count from no log, or from a log that records no methods, proves nothing.
function logControlProblem(counts: RelayLogCounts | null): string | null {
  if (counts === null) {
    return 'relay log counts unreadable'
  }
  if (counts.logs <= 0 || counts.methods <= 0) {
    return `log-presence control failed (logs=${counts.logs}, methods=${counts.methods})`
  }
  return null
}

/** Old relay: the compare says so, no sync./fabric. method was sent, and the log demonstrably records methods. */
export function oldRelayVerdict(input: {
  compareOutput: string
  compareStatus: number
  relayLogCounts: RelayLogCounts | null
  expectedWord?: string
}): LegVerdict {
  const compare = compareVerdict({
    output: input.compareOutput,
    status: input.compareStatus,
    expectedWord: input.expectedWord ?? RELAY_TOO_OLD_WORD
  })
  if (compare.verdict !== 'PASS') {
    return fail(`compare: ${compare.cause}`)
  }
  const problem = logControlProblem(input.relayLogCounts)
  if (problem !== null || input.relayLogCounts === null) {
    return fail(problem ?? 'relay log counts unreadable')
  }
  if (input.relayLogCounts.syncOrFabric > 0) {
    return fail(`${input.relayLogCounts.syncOrFabric} sync./fabric. methods reached the old relay`)
  }
  return pass(
    `${compare.cause}; relay log has ${input.relayLogCounts.methods} methods and none are sync./fabric.`
  )
}

/** Current relay: the same instrument sees sync.replicaFacts, which is what makes the old relay's zero meaningful. */
export function currentRelayVerdict(input: { relayLogCounts: RelayLogCounts | null }): LegVerdict {
  const problem = logControlProblem(input.relayLogCounts)
  if (problem !== null || input.relayLogCounts === null) {
    return fail(problem ?? 'relay log counts unreadable')
  }
  if (input.relayLogCounts.replicaFacts === null) {
    return fail('sync.replicaFacts count was not measured')
  }
  if (input.relayLogCounts.replicaFacts <= 0) {
    return fail('no sync.replicaFacts request reached the current relay')
  }
  return pass(`sync.replicaFacts seen ${input.relayLogCounts.replicaFacts} time(s)`)
}
