import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractRemoteProof } from './dws-remote-ps-capture-proof.mjs'
// Re-exported so `dws-offload-measurement.mjs` stays this instrument's one public entry point.
export { extractRemoteProof }

/**
 * Pure analysis functions for the DWS-P2 local RAM offload measurement instrument (CTX-MEAS-1..4).
 *
 * Consumes NDJSON samples written by config/scripts/dws-laptop-process-sampler.ps1 (one JSON object
 * per line: `sampler-start` / `sample` / `sampler-stop`). Every verdict function returns
 * `{ verdict, reason }` using the vocabulary PASS / FAIL / UNJUDGED / INCONCLUSIVE / OK / MEASURED --
 * never a bare boolean -- because an absence claim without a positive control, or a delta swamped
 * by free-memory drift, is a DIFFERENT answer from a clean pass and must be distinguishable
 * downstream (instrument-before-claim.md: "an instrument that can only ever return one answer
 * carries no information when it returns it").
 *
 * Attribution is by identity, never by name count (presence-is-not-residency.md /
 * real-context-reachability.md): a workload process is one inside the Orca desktop's process
 * subtree matching a known family, or any process outside that subtree whose command line carries
 * the run's nonce. The executor running this very measurement is itself `claude.exe` with hook
 * `node.exe` children spawning throughout the sampling window -- a name-based absence claim would
 * be false by construction, so nothing here ever accuses a process by name alone outside the
 * desktop subtree.
 */

// Why: a process-name comparison is done case-insensitively via this helper everywhere, so
// "node" vs "node.exe" (self-test dummy processes spawn as `node`, Win32_Process reports `node.exe`)
// never silently splits into two different "families".
function nameMatchesAny(proc, candidateNames) {
  const actual = (proc.name ?? '').toLowerCase()
  return candidateNames.some((candidate) => actual === candidate.toLowerCase())
}

function commandLineIncludesAny(proc, substrings) {
  const commandLine = proc.commandLine ?? ''
  return substrings.some((substring) => commandLine.includes(substring))
}

function matchesRule(proc, rule) {
  const nameOk = rule.nameEquals ? nameMatchesAny(proc, rule.nameEquals) : true
  const commandLineOk = rule.commandLineIncludes ? commandLineIncludesAny(proc, rule.commandLineIncludes) : true
  return nameOk && commandLineOk
}

function matchesFamily(proc, familyDef) {
  return familyDef.rules.some((rule) => matchesRule(proc, rule))
}

/**
 * Frozen family/pattern registry (CTX-MEAS-3: "absence judged ... with the family patterns printed
 * beside it"). Each family is a name plus an OR-of-AND match rule over process name / command-line
 * substring -- plain data, not opaque closures, so a summary can print exactly what was matched
 * against and an auditor can read the criteria without reading this file's code.
 */
export const FAMILY_PATTERNS = Object.freeze([
  Object.freeze({
    family: 'vitest',
    rules: Object.freeze([Object.freeze({ nameEquals: ['node.exe', 'node'], commandLineIncludes: ['vitest.mjs'] })])
  }),
  Object.freeze({
    family: 'tsc',
    rules: Object.freeze([
      Object.freeze({
        nameEquals: ['node.exe', 'node'],
        commandLineIncludes: ['typescript/bin/tsc', 'typescript\\bin\\tsc']
      }),
      Object.freeze({ nameEquals: ['tsc.exe'] })
    ])
  }),
  Object.freeze({
    family: 'esbuild',
    rules: Object.freeze([Object.freeze({ nameEquals: ['esbuild.exe'] })])
  }),
  Object.freeze({
    family: 'claude',
    rules: Object.freeze([
      Object.freeze({ nameEquals: ['claude.exe'] }),
      Object.freeze({ nameEquals: ['node.exe', 'node'], commandLineIncludes: ['@anthropic-ai/claude-code'] })
    ])
  }),
  Object.freeze({
    family: 'codex',
    rules: Object.freeze([
      Object.freeze({ nameEquals: ['codex.exe'] }),
      Object.freeze({ nameEquals: ['node.exe', 'node'], commandLineIncludes: ['@openai/codex'] })
    ])
  }),
  Object.freeze({
    family: 'indexer',
    rules: Object.freeze([
      Object.freeze({ nameEquals: ['rg.exe'] }),
      Object.freeze({ nameEquals: ['node.exe', 'node'], commandLineIncludes: ['tsserver'] })
    ])
  }),
  Object.freeze({
    family: 'workload-wrapper',
    rules: Object.freeze([
      Object.freeze({ nameEquals: ['node.exe', 'node'], commandLineIncludes: ['dws-offload-workload.mjs'] })
    ])
  }),
  // orca-cli is a control-plane pattern, not a workload family -- see classifyOneProcess: any
  // process matching it is 'control-plane' EVEN IF its command line also carries the run nonce.
  // Kept in this same registry (not a separate list) so the printed pattern set is complete.
  Object.freeze({
    family: 'orca-cli',
    rules: Object.freeze([
      Object.freeze({ nameEquals: ['node.exe', 'node'], commandLineIncludes: ['out/cli/index.js', 'out\\cli\\index.js'] })
    ])
  })
])

const ORCA_CLI_PATTERN = FAMILY_PATTERNS.find((def) => def.family === 'orca-cli')

function isElectronRenderer(proc) {
  return nameMatchesAny(proc, ['electron.exe', 'electron']) && (proc.commandLine ?? '').includes('--type=renderer')
}

/** Three pairing-credential shapes that must never reach a sampler file or this parser's output. */
const REDACTION_PATTERNS = Object.freeze([
  /orca:\/\/pair\?[^\s"']*/gi,
  /--pairing-code[= ]+\S+/gi,
  /ORCA_PAIRING_CODE=\S+/gi
])

export function redactCommandLine(commandLine) {
  if (typeof commandLine !== 'string' || commandLine.length === 0) {
    return commandLine ?? ''
  }
  let result = commandLine
  for (const pattern of REDACTION_PATTERNS) {
    result = result.replace(pattern, '<redacted>')
  }
  return result
}

/**
 * Parses sampler NDJSON. Strips a leading U+FEFF (PowerShell 5.1 `-Encoding UTF8` BOM trap --
 * "the parser is part of the guard"). A malformed line is COUNTED in `unreadableLines`, never
 * silently dropped, so judgeBracket can escalate a run with unreadable lines to INCONCLUSIVE.
 * Every proc's commandLine is re-redacted here too (defense-in-depth, T-02-04b: redaction in the
 * sampler before write AND in the analysis parser).
 */
export function parseSamples(text) {
  const stripped = text.length > 0 && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const lines = stripped.split(/\r\n|\n/).filter((line) => line.length > 0)

  const samples = []
  let start = null
  let stop = null
  let unreadableLines = 0

  for (const line of lines) {
    let record
    try {
      record = JSON.parse(line)
    } catch {
      unreadableLines += 1
      continue
    }
    if (!record || typeof record !== 'object') {
      unreadableLines += 1
      continue
    }
    if (record.kind === 'sample') {
      if (Array.isArray(record.procs)) {
        record.procs = record.procs.map((proc) => ({ ...proc, commandLine: redactCommandLine(proc.commandLine) }))
      }
      samples.push(record)
    } else if (record.kind === 'sampler-start') {
      start = record
    } else if (record.kind === 'sampler-stop') {
      stop = record
    }
  }

  return { samples, start, stop, unreadableLines, totalLines: lines.length }
}

/** All pids in the subtree rooted at rootPid (inclusive), from one sample's flat process list. */
export function subtreePids(procs, rootPid) {
  const childrenByParent = new Map()
  for (const proc of procs) {
    const siblings = childrenByParent.get(proc.ppid) ?? []
    siblings.push(proc.pid)
    childrenByParent.set(proc.ppid, siblings)
  }
  const result = new Set([rootPid])
  const queue = [rootPid]
  while (queue.length > 0) {
    const current = queue.shift()
    for (const child of childrenByParent.get(current) ?? []) {
      if (!result.has(child)) {
        result.add(child)
        queue.push(child)
      }
    }
  }
  return result
}

function classifyOneProcess(proc, { desktopSubtree, nonce }) {
  // Checked FIRST, before the nonce rule: the dispatching Orca CLI names the workload it is
  // dispatching (its argv legitimately carries the nonce) without itself BEING the workload.
  if (matchesFamily(proc, ORCA_CLI_PATTERN)) {
    return 'control-plane'
  }

  if (desktopSubtree.has(proc.pid)) {
    if (isElectronRenderer(proc)) {
      return 'control-surface'
    }
    const workloadFamily = FAMILY_PATTERNS.find((def) => def.family !== 'orca-cli' && matchesFamily(proc, def))
    if (workloadFamily) {
      return `workload:${workloadFamily.family}`
    }
    // Orca's own subtree, unrecognized role (main/gpu/utility electron, or an unclassified hook
    // node) -- still the desktop app's own footprint, never accused as offloaded workload.
    return 'control-surface'
  }

  // Outside the desktop subtree: only a nonce match accuses. A pre-existing process (present
  // before the run started) and a process spawned mid-window with no nonce are indistinguishable
  // in effect -- both are 'background' -- because a name-based guess is exactly the false-by-
  // construction trap this module exists to avoid (the executor's own claude.exe + hook node.exe
  // children fall in this bucket every run).
  if (nonce && typeof proc.commandLine === 'string' && proc.commandLine.includes(nonce)) {
    const matchedFamily = FAMILY_PATTERNS.find((def) => matchesFamily(proc, def))
    return `workload:${matchedFamily ? matchedFamily.family : 'nonce'}`
  }
  return 'background'
}

/**
 * Subtree membership (ppid-chain ancestry), unioned across every sample. Shared by classifyRun
 * and summarizeRun so the two never compute it differently.
 */
export function computeSubtrees(samples, { desktopRootPid, harnessRootPids = [] } = {}) {
  const desktopSubtree = new Set()
  const harnessSubtree = new Set()
  for (const sample of samples) {
    for (const pid of subtreePids(sample.procs ?? [], desktopRootPid)) {
      desktopSubtree.add(pid)
    }
    for (const root of harnessRootPids) {
      for (const pid of subtreePids(sample.procs ?? [], root)) {
        harnessSubtree.add(pid)
      }
    }
  }
  return { desktopSubtree, harnessSubtree }
}

/**
 * Classifies every unique process PID seen across the run, using the FIRST sample in which each
 * pid appears, into control-plane / control-surface / workload:<family> / background.
 * `harnessRootPids` (the measurement executor's own root pids, e.g. this session's claude.exe) is
 * resolved into its own subtree and exposed as `harnessSubtreeSize` for observability -- it never
 * overrides a nonce match (see classifyOneProcess), since the self-test's own smoke processes are
 * children of the harness yet must still be accused via the nonce as the positive control that
 * identity attribution fires.
 *
 * CAUTION -- this is a "first sighting per pid" DIAGNOSTIC view, not the instrument that judges a
 * run: on a long (multi-minute), heavily-loaded Windows host, PIDs churn fast enough that a pid can
 * belong to a short-lived, unrelated process in an early sample and then be REUSED by the real
 * workload later in the same run -- this function would report the workload's bytes under the
 * earlier, unrelated process's identity forever, because it locks in one classification per pid for
 * the whole run. Measured live during this plan's own baseline run (2026-09-28): pid 35888 was a
 * `.claude/hooks/anti-thrash.js` helper at sample[27], exited, and was reused by the REAL
 * `vitest.mjs` process at sample[117] (137s later) -- a naive per-pid cache attributed zero bytes to
 * vitest and silently folded them into `control-surface` instead, at real memory numbers big enough
 * (control-surface peakMb 2216 vs an expected few hundred) that the run still "looked" plausible.
 * `summarizeRun` does NOT use this function's output for that reason -- it classifies every
 * (sample, proc) occurrence fresh instead (see below). This function is kept for its own tests and
 * for any future caller that genuinely wants a single first-seen identity per pid.
 */
export function classifyRun(samples, { desktopRootPid, nonce, harnessRootPids = [] } = {}) {
  const { desktopSubtree, harnessSubtree } = computeSubtrees(samples, { desktopRootPid, harnessRootPids })

  const byPid = new Map()
  for (const sample of samples) {
    for (const proc of sample.procs ?? []) {
      if (!byPid.has(proc.pid)) {
        byPid.set(proc.pid, proc)
      }
    }
  }

  const processes = []
  for (const proc of byPid.values()) {
    processes.push({
      pid: proc.pid,
      ppid: proc.ppid,
      name: proc.name,
      commandLine: proc.commandLine ?? '',
      creationDate: proc.creationDate ?? null,
      classification: classifyOneProcess(proc, { desktopSubtree, nonce })
    })
  }

  return { processes, desktopSubtreeSize: desktopSubtree.size, harnessSubtreeSize: harnessSubtree.size }
}

function median(values) {
  if (values.length === 0) {
    return null
  }
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function quantile(sortedValues, q) {
  const pos = (sortedValues.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  if (sortedValues[base + 1] !== undefined) {
    return sortedValues[base] + rest * (sortedValues[base + 1] - sortedValues[base])
  }
  return sortedValues[base]
}

const DEFAULT_INSTRUMENT = 'Win32_Process.WorkingSetSize via Get-CimInstance'

/**
 * Aggregates one run's samples into per-family peak/median (median taken only over samples where
 * the family is present -- an absent family is not a zero data point, it is no data point), a
 * per-sample workload total (control-plane/control-surface/background excluded), the observed
 * sampling cadence, and the free-memory bracket. `patterns` echoes FAMILY_PATTERNS so a printed
 * summary always carries the criteria beside every count (CTX-MEAS-3).
 */
export function summarizeRun(samples, opts = {}) {
  const {
    desktopRootPid,
    nonce,
    harnessRootPids = [],
    unreadableLines = 0,
    instrument = DEFAULT_INSTRUMENT
  } = opts

  // Why classify per (sample, proc) occurrence here, NOT via classifyRun's per-pid cache: a pid is
  // only a stable identity for as long as one real process holds it. On a long, heavily-loaded
  // Windows host a pid can be reused by an unrelated process partway through the run, and
  // classifyRun's "first sighting wins" cache would then attribute every later sample's bytes to
  // the FIRST process's identity forever -- see classifyRun's own doc comment for the real
  // measured incident this fixes (2026-09-28 baseline run, pid 35888: an unrelated hook process at
  // sample[27], the real vitest.mjs from sample[117] onward). Classifying fresh per occurrence
  // means a reused pid is judged by whichever process actually held it at that sample.
  //
  // Desktop-subtree MEMBERSHIP is also computed fresh per sample below (subtreePids on that
  // sample's own procs), not via a set unioned across the whole run: a unioned set has the
  // identical reuse vulnerability one level removed -- a pid that is a desktop descendant in a
  // LATER sample would otherwise leak that membership backward onto an unrelated EARLIER
  // occupant of the same pid number. computeSubtrees' unioned sizes are kept only as a
  // reporting-only diagnostic (desktopSubtreeSize/harnessSubtreeSize below), never for
  // classification.
  const { desktopSubtree: desktopSubtreeUnionForReporting, harnessSubtree: harnessSubtreeUnionForReporting } =
    computeSubtrees(samples, { desktopRootPid, harnessRootPids })

  const trackedFamilies = [...new Set([...FAMILY_PATTERNS.map((def) => def.family), 'nonce', 'control-surface'])]
  const mbBySampleByFamily = new Map(trackedFamilies.map((f) => [f, new Array(samples.length).fill(0)]))
  const countBySampleByFamily = new Map(trackedFamilies.map((f) => [f, new Array(samples.length).fill(0)]))
  const observedByFamily = new Map(trackedFamilies.map((f) => [f, new Map()]))
  const workloadTotalPerSampleMb = new Array(samples.length).fill(0)

  samples.forEach((sample, sampleIndex) => {
    const sampleDesktopSubtree = subtreePids(sample.procs ?? [], desktopRootPid)
    for (const proc of sample.procs ?? []) {
      const classification = classifyOneProcess(proc, { desktopSubtree: sampleDesktopSubtree, nonce })
      let family = null
      if (classification.startsWith('workload:')) {
        family = classification.slice('workload:'.length)
      } else if (classification === 'control-surface') {
        family = 'control-surface'
      }
      if (!family) {
        continue
      }
      const mb = proc.workingSetMb ?? 0
      mbBySampleByFamily.get(family)[sampleIndex] += mb
      countBySampleByFamily.get(family)[sampleIndex] += 1
      // Keyed by pid+commandLine (not pid alone): a reused pid whose later occupant has a
      // different commandLine is a genuinely different observation and must not be folded
      // into -- or silently overwrite -- the earlier one.
      const observedKey = `${proc.pid}\u0000${proc.commandLine ?? ''}`
      if (!observedByFamily.get(family).has(observedKey)) {
        observedByFamily.get(family).set(observedKey, { pid: proc.pid, commandLine: proc.commandLine ?? '' })
      }
      if (family !== 'control-surface') {
        workloadTotalPerSampleMb[sampleIndex] += mb
      }
    }
  })

  const perFamily = {}
  for (const family of trackedFamilies) {
    const mbSeries = mbBySampleByFamily.get(family)
    const countSeries = countBySampleByFamily.get(family)
    const presentMb = mbSeries.filter((_, i) => countSeries[i] > 0)
    perFamily[family] = {
      peakMb: presentMb.length > 0 ? Math.max(...presentMb) : 0,
      medianMb: presentMb.length > 0 ? median(presentMb) : 0,
      maxCount: countSeries.length > 0 ? Math.max(...countSeries) : 0,
      samplesPresent: presentMb.length,
      observed: [...observedByFamily.get(family).values()]
    }
  }

  const freeSeries = samples.map((s) => s.freeMb)
  const monoSeries = samples.map((s) => s.monoMs).filter((v) => typeof v === 'number')
  const cadenceDeltas = []
  for (let i = 1; i < monoSeries.length; i += 1) {
    cadenceDeltas.push(monoSeries[i] - monoSeries[i - 1])
  }

  return {
    perFamily,
    workloadTotalPerSampleMb,
    workloadTotal: {
      peakMb: workloadTotalPerSampleMb.length > 0 ? Math.max(...workloadTotalPerSampleMb) : 0,
      medianMb: workloadTotalPerSampleMb.length > 0 ? median(workloadTotalPerSampleMb) : 0
    },
    cadence: {
      medianMs: cadenceDeltas.length > 0 ? median(cadenceDeltas) : null,
      samples: samples.length
    },
    freeMb: {
      before: freeSeries.length > 0 ? freeSeries[0] : null,
      after: freeSeries.length > 0 ? freeSeries[freeSeries.length - 1] : null,
      min: freeSeries.length > 0 ? Math.min(...freeSeries) : null
    },
    instrument,
    unreadableLines,
    patterns: FAMILY_PATTERNS,
    desktopSubtreeSize: desktopSubtreeUnionForReporting.size,
    harnessSubtreeSize: harnessSubtreeUnionForReporting.size
  }
}

/**
 * Absence is PASS only when the SAME instrument saw this family during the baseline (positive
 * control). No baseline sighting -> UNJUDGED, never PASS (instrument-before-claim.md).
 */
export function judgeAbsence(baselineSummary, offloadSummary, family) {
  const baselineFamily = baselineSummary.perFamily?.[family]
  const offloadFamily = offloadSummary.perFamily?.[family]
  const baselineSeen = (baselineFamily?.maxCount ?? 0) >= 1

  if (!baselineSeen) {
    return { verdict: 'UNJUDGED', reason: 'no positive control' }
  }

  const offloadCount = offloadFamily?.maxCount ?? 0
  if (offloadCount === 0) {
    return {
      verdict: 'PASS',
      reason: `baseline saw ${family} (max concurrent count ${baselineFamily.maxCount}); offload saw none`
    }
  }

  const detail = (offloadFamily.observed ?? []).map((o) => `pid ${o.pid}: ${o.commandLine}`).join('; ')
  return { verdict: 'FAIL', reason: detail || `offload saw ${offloadCount} ${family} process(es)` }
}

/** Per-family and total (baseline minus offload) delta; control-surface excluded from the workload total. */
export function computeDelta(baselineSummary, offloadSummary) {
  const families = new Set([
    ...Object.keys(baselineSummary.perFamily ?? {}),
    ...Object.keys(offloadSummary.perFamily ?? {})
  ])
  const perFamily = {}
  // CTX-MEAS-2/CTX-MEAS-3: per family, the absence verdict (PASS only with a baseline positive
  // control -- see judgeAbsence) travels beside the delta, with the exact match pattern printed so
  // "0 processes for family X" is never a bare claim. Kept in a SEPARATE top-level field, not
  // merged into perFamily[family] itself, so 02-03's own `toEqual({peakDeltaMb, medianDeltaMb})`
  // assertions on that exact shape stay green.
  const absenceByFamily = {}
  const patternByFamily = new Map(FAMILY_PATTERNS.map((def) => [def.family, def.rules]))
  for (const family of families) {
    const b = baselineSummary.perFamily?.[family] ?? { peakMb: 0, medianMb: 0 }
    const o = offloadSummary.perFamily?.[family] ?? { peakMb: 0, medianMb: 0 }
    perFamily[family] = { peakDeltaMb: b.peakMb - o.peakMb, medianDeltaMb: b.medianMb - o.medianMb }
    if (family === 'control-surface' || family === 'nonce') {
      continue
    }
    const verdict = judgeAbsence(baselineSummary, offloadSummary, family)
    absenceByFamily[family] = { ...verdict, pattern: patternByFamily.get(family) ?? null }
  }
  const controlSurfaceDelta = perFamily['control-surface'] ?? { peakDeltaMb: 0, medianDeltaMb: 0 }
  const controlSurfaceFootprint = {
    baseline: baselineSummary.perFamily?.['control-surface'] ?? null,
    offload: offloadSummary.perFamily?.['control-surface'] ?? null
  }
  const workloadTotalDelta = {
    peakDeltaMb: (baselineSummary.workloadTotal?.peakMb ?? 0) - (offloadSummary.workloadTotal?.peakMb ?? 0),
    medianDeltaMb: (baselineSummary.workloadTotal?.medianMb ?? 0) - (offloadSummary.workloadTotal?.medianMb ?? 0)
  }
  // offloadSummary may be a caller-constructed fixture/partial summary carrying no freeMb -- an
  // absent bracket precondition is UNJUDGED, never a thrown TypeError (instrument-before-claim.md).
  const bracket = offloadSummary.freeMb
    ? judgeBracket(offloadSummary, workloadTotalDelta.peakDeltaMb)
    : { verdict: 'UNJUDGED', reason: 'offload summary carries no freeMb data' }
  return { perFamily, workloadTotalDelta, controlSurfaceDelta, absenceByFamily, controlSurfaceFootprint, bracket }
}

/**
 * A run whose free-memory drift is at least as large as the delta cannot distinguish the offload
 * effect from ordinary host memory churn -> INCONCLUSIVE. A run with unreadable NDJSON lines is
 * also INCONCLUSIVE regardless of drift (an unreadable line could have hidden the very process
 * being measured).
 */
export function judgeBracket(runSummary, deltaMb) {
  if ((runSummary.unreadableLines ?? 0) > 0) {
    return { verdict: 'INCONCLUSIVE', reason: `unreadable lines present (${runSummary.unreadableLines})` }
  }
  const drift = Math.abs(runSummary.freeMb.before - runSummary.freeMb.after)
  const threshold = Math.abs(deltaMb)
  if (drift >= threshold) {
    return { verdict: 'INCONCLUSIVE', reason: `free-memory drift ${drift}MB >= delta ${threshold}MB` }
  }
  return { verdict: 'OK', reason: `free-memory drift ${drift}MB < delta ${threshold}MB` }
}

/** Fewer than 5 samples -> UNJUDGED (not enough data to report a spread). */
export function summarizeLatencies(values, { instrument, resolutionMs } = {}) {
  if (!Array.isArray(values) || values.length < 5) {
    return { verdict: 'UNJUDGED', reason: 'fewer than 5 samples', count: values?.length ?? 0, instrument, resolutionMs }
  }
  const sorted = [...values].sort((a, b) => a - b)
  const q1 = quantile(sorted, 0.25)
  const q3 = quantile(sorted, 0.75)
  return {
    verdict: 'MEASURED',
    medianMs: median(sorted),
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    iqrMs: q3 - q1,
    count: values.length,
    instrument,
    resolutionMs
  }
}

// --- CLI (summarize / compare / latency / remote-proof) -------------------------------------
// Guarded by an import.meta.url check so `import`ing this module for its pure functions (as the
// test file does) never triggers CLI side effects.

function parseCliArgs(args) {
  const options = {}
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg.startsWith('--')) {
      options[arg.slice(2)] = args[i + 1]
      i += 1
    }
  }
  return options
}

function readTextFileOrExit(filePath, label) {
  if (!filePath) {
    process.stderr.write(`UNREADABLE INPUT: ${label} not provided\n`)
    process.exit(2)
  }
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    process.stderr.write(`UNREADABLE INPUT: ${label} (${filePath}): ${error.message}\n`)
    process.exit(2)
  }
}

function readJsonFileOrExit(filePath, label) {
  const text = readTextFileOrExit(filePath, label)
  try {
    return JSON.parse(text)
  } catch (error) {
    process.stderr.write(`UNREADABLE INPUT: ${label} is not valid JSON (${filePath}): ${error.message}\n`)
    process.exit(2)
  }
}

function writeJsonOutputIfRequested(outPath, value) {
  if (outPath) {
    fs.writeFileSync(outPath, JSON.stringify(value, null, 2))
  }
}

function runSummarizeCommand(options) {
  const samplesText = readTextFileOrExit(options.samples, 'samples file')
  const manifest = readJsonFileOrExit(options.manifest, 'manifest file')
  const parsed = parseSamples(samplesText)
  const summary = summarizeRun(parsed.samples, {
    desktopRootPid: manifest.desktopRootPid,
    nonce: manifest.nonce,
    harnessRootPids: manifest.harnessRootPids ?? [],
    unreadableLines: parsed.unreadableLines
  })
  writeJsonOutputIfRequested(options.out, summary)
  process.stdout.write(
    `SUMMARY observedCadenceMs=${summary.cadence.medianMs ?? 'null'} unreadableLines=${summary.unreadableLines} totalLines=${parsed.totalLines}\n`
  )
  // CTX-MEAS-3: print the family patterns beside every count, so "0 processes for family X" is
  // never a bare claim.
  for (const pattern of summary.patterns) {
    const entry = summary.perFamily[pattern.family]
    process.stdout.write(
      `FAMILY ${pattern.family} maxCount=${entry ? entry.maxCount : 0} peakMb=${entry ? entry.peakMb : 0} medianMb=${entry ? entry.medianMb : 0} rules=${JSON.stringify(pattern.rules)}\n`
    )
  }
  const nonceEntry = summary.perFamily.nonce
  if (nonceEntry) {
    process.stdout.write(`FAMILY nonce maxCount=${nonceEntry.maxCount} peakMb=${nonceEntry.peakMb} medianMb=${nonceEntry.medianMb}\n`)
  }
  const controlSurfaceEntry = summary.perFamily['control-surface']
  if (controlSurfaceEntry) {
    process.stdout.write(
      `FAMILY control-surface maxCount=${controlSurfaceEntry.maxCount} peakMb=${controlSurfaceEntry.peakMb} medianMb=${controlSurfaceEntry.medianMb}\n`
    )
  }
}

function runCompareCommand(options) {
  const baseline = readJsonFileOrExit(options.baseline, 'baseline summary file')
  const offload = readJsonFileOrExit(options.offload, 'offload summary file')
  const delta = computeDelta(baseline, offload)
  writeJsonOutputIfRequested(options.out, delta)
  process.stdout.write(
    `COMPARE workloadTotalPeakDeltaMb=${delta.workloadTotalDelta.peakDeltaMb} workloadTotalMedianDeltaMb=${delta.workloadTotalDelta.medianDeltaMb}\n`
  )
}

function runLatencyCommand(options) {
  const values = readJsonFileOrExit(options.values, 'latency values file')
  const resolutionMs = options['resolution-ms'] !== undefined ? Number(options['resolution-ms']) : undefined
  const result = summarizeLatencies(values, { instrument: options.instrument, resolutionMs })
  writeJsonOutputIfRequested(options.out, result)
  process.stdout.write(`LATENCY verdict=${result.verdict} medianMs=${result.medianMs ?? 'null'} iqrMs=${result.iqrMs ?? 'null'}\n`)
}

function runRemoteProofCommand(options) {
  const captureText = readTextFileOrExit(options.capture, 'remote ps-capture transcript')
  const manifest = readJsonFileOrExit(options.manifest, 'workload manifest file')
  const servePid = Number(options['serve-pid'])
  if (!Number.isFinite(servePid) || servePid <= 0) {
    process.stderr.write(`UNREADABLE INPUT: --serve-pid must be a positive integer (got ${options['serve-pid']})\n`)
    process.exit(2)
  }
  const legs = Array.isArray(manifest.legs) ? manifest.legs.map((entry) => entry.leg) : []
  if (legs.length === 0) {
    process.stderr.write(`UNREADABLE INPUT: manifest file (${options.manifest}) carries no legs[] array\n`)
    process.exit(2)
  }
  const proofs = extractRemoteProof(captureText, { servePid, legs })
  writeJsonOutputIfRequested(options.out, proofs)
  for (const proof of proofs) {
    process.stdout.write(
      `REMOTE-PROOF leg=${proof.leg} verdict=${proof.verdict}${proof.reason ? ` reason="${proof.reason}"` : ''}${
        proof.peakRssMb !== undefined ? ` peakRssMb=${proof.peakRssMb}` : ''
      }\n`
    )
  }
}

async function runCli(argv) {
  const [command, ...rest] = argv
  const options = parseCliArgs(rest)
  if (command === 'summarize') {
    return runSummarizeCommand(options)
  }
  if (command === 'compare') {
    return runCompareCommand(options)
  }
  if (command === 'latency') {
    return runLatencyCommand(options)
  }
  if (command === 'remote-proof') {
    return runRemoteProofCommand(options)
  }
  process.stderr.write(`Unknown command: ${command}. Expected one of: summarize, compare, latency, remote-proof\n`)
  process.exit(2)
}

function isRunAsCli() {
  if (!process.argv[1]) {
    return false
  }
  try {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

if (isRunAsCli()) {
  await runCli(process.argv.slice(2))
}
