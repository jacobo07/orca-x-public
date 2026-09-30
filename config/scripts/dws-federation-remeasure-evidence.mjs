// Pure evidence tooling for the phase-7 federation re-measure: parse the remote gate summary, judge two
// fences (attribution then head) with pre-existing red attributed, and refuse secret-shaped text.
export const VERDICTS = ['MEASURED', 'BLOCKED', 'FAIL']
export const EVIDENCE_SCHEMA = 'orca.dws-federation-remeasure/1'
export const VITEST_FILE_FLOOR = 90
export const DISK_FLOOR_GB = 5
export const ATTRIBUTION_SHA_SHORT = '71dd7bc97'
export const REALITY_FILES = [
  'review-reality.test.ts',
  'claude-conversation-reality.test.ts',
  'claude-mcp-bridge-reality.test.ts'
]
const SHA40 = /^[0-9a-f]{40}$/

const SECRET_RULES = [
  ['pairing-url', /orca:\/\/pair/i],
  ['code-query', /\?code=/i],
  ['token-run', /(?:token|bearer)\W{0,10}[A-Za-z0-9+/_-]{64,}={0,2}/i],
  ['token-run', /[A-Za-z0-9+/_-]{64,}={0,2}\W{0,10}(?:token|bearer)/i],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{16,}/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['agent-home', /\/home\/kobii\/\.(?:claude|codex)/]
]

export function scanForSecrets(text) {
  return [...new Set(SECRET_RULES.filter(([, pattern]) => pattern.test(text)).map(([rule]) => rule))]
}

function toInt(text) {
  return /^\d+$/.test(text ?? '') ? Number(text) : null
}

// Grammar is the contract with dws-federation-gates-remote.sh (asserted by a text test on the script).
export function parseGateSummary(text) {
  const out = {
    label: null,
    sha: null,
    revBeforeGates: null,
    nodeVersion: null,
    diskFreeGbBefore: null,
    diskFreeGbAfter: null,
    gates: {},
    tscErrorCount: null,
    vitestFiles: null,
    realityEnv: null,
    vitest: null,
    treeClean: null,
    missingTestFiles: [],
    blocked: null,
    done: false,
    incomplete: false
  }
  for (const raw of String(text ?? '').replace(/\r/g, '').split('\n')) {
    const line = raw.trim()
    let m
    if ((m = /^P7_BEGIN label=(\S+) sha=([0-9a-f]{40})$/.exec(line))) {
      out.label = m[1]
      out.sha = m[2]
    } else if ((m = /^REV_BEFORE_GATES ([0-9a-f]{40})$/.exec(line))) {
      out.revBeforeGates = m[1]
    } else if ((m = /^NODE_VERSION (\S+)$/.exec(line))) {
      out.nodeVersion = m[1]
    } else if ((m = /^DISK_FREE_GB_BEFORE (\d+)$/.exec(line))) {
      out.diskFreeGbBefore = Number(m[1])
    } else if ((m = /^DISK_FREE_GB_AFTER (\d+)$/.exec(line))) {
      out.diskFreeGbAfter = Number(m[1])
    } else if ((m = /^GATE ([a-z0-9-]+) rc=(-?\d+)$/.exec(line))) {
      out.gates[m[1]] = Number(m[2])
    } else if ((m = /^TSC_ERRORS (\d+)$/.exec(line))) {
      out.tscErrorCount = Number(m[1])
    } else if ((m = /^VITEST_FILES (\d+)$/.exec(line))) {
      out.vitestFiles = Number(m[1])
    } else if ((m = /^ORCA_CLAUDE_REALITY (\S+)$/.exec(line))) {
      out.realityEnv = m[1]
    } else if ((m = /^VITEST total=(\d+) passed=(\d+) failed=(\d+) skipped=(\d+) suites=(\d+) skippedFiles=(\d+)$/.exec(line))) {
      const [total, passed, failed, skipped, suites, skippedFiles] = m.slice(1).map(Number)
      out.vitest = { total, passed, failed, skipped, suites, skippedFiles }
    } else if ((m = /^TREE_CLEAN=([01])$/.exec(line))) {
      out.treeClean = m[1] === '1'
    } else if ((m = /^MISSING_TEST_FILE (\S+)$/.exec(line))) {
      out.missingTestFiles.push(m[1])
    } else if ((m = /^BLOCKED (\S+)(?: (.*))?$/.exec(line))) {
      out.blocked = { rung: m[1], reason: m[2] ?? m[1] }
    } else if (line === 'P7_DONE') {
      out.done = true
    }
  }
  out.incomplete = !out.done
  return out
}

function redSet(fence, parsed) {
  const red = new Set()
  for (const line of fence.tscErrors ?? []) {
    red.add(`tsc: ${line}`)
  }
  for (const name of fence.failedTests ?? []) {
    red.add(`vitest: ${name}`)
  }
  if (parsed.gates.migration !== undefined && parsed.gates.migration !== 0) {
    red.add('gate: migration')
  }
  if (parsed.gates['tsc-node'] && (fence.tscErrors ?? []).length === 0) {
    red.add('gate: tsc-node rc without error lines')
  }
  if (parsed.gates.vitest && (fence.failedTests ?? []).length === 0) {
    red.add('gate: vitest rc without failed test names')
  }
  return red
}

function blockedBy(rung, reason) {
  return { verdict: 'BLOCKED', rungReached: rung, blockedReason: reason }
}

// Shared by the --record build path and the persisted-file validator: takes the fenceEvidence() shape.
export function fenceCoherenceBlock(label, fe) {
  if ((fe.missingTestFiles ?? []).length > 0) {
    return blockedBy('named-file-missing', `${label}: named federation test file(s) absent: ${fe.missingTestFiles.join(', ')}`)
  }
  return null
}

function fenceBlock(label, fence, parsed, expectedRev) {
  if (parsed.blocked) {
    return blockedBy(parsed.blocked.rung, `${label}: ${parsed.blocked.reason}`)
  }
  if (fence.blocked) {
    return blockedBy(fence.blocked.rung, `${label}: ${fence.blocked.reason ?? fence.blocked.rung}`)
  }
  if (fence.remoteRevParse !== expectedRev || (parsed.revBeforeGates && parsed.revBeforeGates !== expectedRev)) {
    return blockedBy('fence-mismatch', `${label}: remote rev-parse differs from the fenced sha`)
  }
  if (parsed.incomplete) {
    return blockedBy('gates-timeout', `${label}: summary has no P7_DONE marker`)
  }
  if (!String(parsed.nodeVersion ?? '').startsWith('v24')) {
    return blockedBy('toolchain', `${label}: node is ${parsed.nodeVersion ?? 'unknown'}, not v24`)
  }
  if (parsed.treeClean !== true) {
    return blockedBy('tree-dirty', `${label}: tracked tree not clean after the gates`)
  }
  if ((parsed.diskFreeGbBefore ?? 0) < DISK_FLOOR_GB) {
    return blockedBy('disk-floor', `${label}: disk free below ${DISK_FLOOR_GB} GiB`)
  }
  if (parsed.gates['db-probe'] !== 0) {
    return blockedBy('db-probe', `${label}: db-probe rc=${parsed.gates['db-probe'] ?? 'missing'}`)
  }
  if ((parsed.vitestFiles ?? 0) < VITEST_FILE_FLOOR) {
    return blockedBy('file-list-below-floor', `${label}: ${parsed.vitestFiles ?? 0} files < ${VITEST_FILE_FLOOR}`)
  }
  const skipped = new Set(fence.skippedFiles ?? [])
  if (parsed.realityEnv !== 'unset' || !REALITY_FILES.every((f) => skipped.has(f))) {
    return blockedBy('reality-legs-not-skipped', `${label}: reality tests were not all skipped with the variable unset`)
  }
  if (!parsed.vitest || parsed.gates.migration === undefined || parsed.gates['tsc-node'] === undefined) {
    return blockedBy('gates-timeout', `${label}: gate lines missing from the summary`)
  }
  return fenceCoherenceBlock(label, fenceEvidence(fence))
}

export function judgeRemeasure({ headFence, attributionFence, localHead, containment, timeouts, blocked }) {
  if (blocked) {
    return { ...blockedBy(blocked.rung, blocked.reason), preExistingRed: [], headOnlyRed: [] }
  }
  const none = { preExistingRed: [], headOnlyRed: [] }
  if (containment?.fetch?.outcome !== 'ok') {
    return { ...blockedBy('fetch', 'git fetch of the federation ref did not succeed; refs are stale'), ...none }
  }
  if ((timeouts ?? []).length > 0) {
    return { ...blockedBy('ssh', `wall-clock timeout on a remote call: ${timeouts.join(', ')}`), ...none }
  }
  if (!attributionFence) {
    return { ...blockedBy('attribution-fence', 'attribution fence did not run'), ...none }
  }
  if (!headFence) {
    return { ...blockedBy('head-fence', 'head fence did not run'), ...none }
  }
  const attrParsed = parseGateSummary(attributionFence.summaryText)
  const headParsed = parseGateSummary(headFence.summaryText)
  const attrBlock = fenceBlock('attribution', attributionFence, attrParsed, attributionFence.sha)
  if (attrBlock) {
    return { ...attrBlock, ...none }
  }
  const headBlock = fenceBlock('head', headFence, headParsed, localHead)
  if (headBlock) {
    return { ...headBlock, ...none }
  }
  const attrRed = redSet(attributionFence, attrParsed)
  const headRed = redSet(headFence, headParsed)
  const headOnlyRed = [...headRed].filter((item) => !attrRed.has(item)).sort()
  const preExistingRed = [...headRed].filter((item) => attrRed.has(item)).sort()
  return {
    verdict: headOnlyRed.length > 0 ? 'FAIL' : 'MEASURED',
    rungReached: 'gates',
    blockedReason: null,
    preExistingRed,
    headOnlyRed
  }
}

function fenceEvidence(fence) {
  if (!fence) {
    return null
  }
  const parsed = parseGateSummary(fence.summaryText)
  return {
    sha: fence.sha ?? null,
    label: fence.label ?? null,
    remoteRevParse: fence.remoteRevParse ?? null,
    fenceOk: fence.fenceOk ?? null,
    orcaXHeadBefore: fence.orcaXHeadBefore ?? null,
    orcaXHeadAfter: fence.orcaXHeadAfter ?? null,
    nodeVersion: parsed.nodeVersion,
    gates: parsed.gates,
    vitest: parsed.vitest,
    vitestFiles: parsed.vitestFiles,
    tscErrorCount: parsed.tscErrorCount,
    realityEnv: parsed.realityEnv,
    diskFreeGbBefore: parsed.diskFreeGbBefore,
    diskFreeGbAfter: parsed.diskFreeGbAfter,
    treeClean: parsed.treeClean,
    missingTestFiles: [...parsed.missingTestFiles].sort(),
    failedTests: [...(fence.failedTests ?? [])].sort(),
    tscErrors: [...(fence.tscErrors ?? [])].sort(),
    skippedFiles: [...(fence.skippedFiles ?? [])].sort(),
    blocked: parsed.blocked ?? fence.blocked ?? null,
    utcStart: fence.utcStart ?? null,
    utcEnd: fence.utcEnd ?? null
  }
}

export function buildEvidence(record) {
  const judged = judgeRemeasure({
    headFence: record.fences?.head,
    attributionFence: record.fences?.attribution,
    localHead: record.headSha,
    containment: record.containment,
    timeouts: record.timeouts,
    blocked: record.blocked
  })
  const evidence = {
    schema: EVIDENCE_SCHEMA,
    verdict: judged.verdict,
    rungReached: judged.rungReached,
    blockedReason: judged.blockedReason,
    headSha: record.headSha,
    gatesFencedSha: record.headSha,
    serveDeployedSha: record.serveDeployedSha ?? null,
    federationHead: record.federationHead ?? null,
    containment: record.containment ?? null,
    fences: { attribution: fenceEvidence(record.fences?.attribution), head: fenceEvidence(record.fences?.head) },
    attribution: { preExistingRed: judged.preExistingRed, headOnlyRed: judged.headOnlyRed },
    ownership: record.ownership ?? null,
    cloneHeadAtEnd: record.cloneHeadAtEnd ?? null,
    orcaXHeadAtEnd: record.orcaXHeadAtEnd ?? null,
    cloneLeftAtGatedSha: record.cloneLeftAtGatedSha ?? null,
    ...(record.cloneLeftNote ? { cloneLeftNote: record.cloneLeftNote } : {}),
    notRerun: [
      "federation's mutation drills: federation's own claim, not re-run because they edit federation-owned files",
      'tests/e2e/agent-federation-approval.spec.ts: NOT-RERUN, federation P6 evidence ddc6f67d8'
    ],
    correction:
      'Federation cites live-review commit 2e8c5516a, which is not present in the object store; da3ec43c0 and 47558af87 are the cited evidence.',
    inheritedDebt: [
      'orchestration.reviewRequest, orchestration.reviewShow, conversations.subscribe and conversations.unsubscribe are unfixed mobile-aperture entries: federation debt, not fixed here',
      'ND-1: the legal lane is the Orca bundle+ssh evidence lane until UWCP S5 dispatcher lands'
    ],
    evidenceCommitBoundary:
      'Gates ran at the fenced sha S; the evidence commit E may touch only docs/dws/, the requirements matrix and the allow-list.',
    utc: record.utc ?? null
  }
  const found = scanForSecrets(JSON.stringify(evidence))
  if (found.length > 0) {
    throw new Error(`evidence refused: secret pattern(s) found: ${found.join(', ')}`)
  }
  return evidence
}

export function validateEvidence(evidence) {
  const problems = []
  if (!VERDICTS.includes(evidence?.verdict)) {
    problems.push(`verdict ${evidence?.verdict} is not one of ${VERDICTS.join('/')}`)
  }
  if (!SHA40.test(evidence?.headSha ?? '')) {
    problems.push('headSha is not 40 hex')
  }
  if (evidence?.verdict === 'MEASURED' || evidence?.verdict === 'FAIL') {
    for (const label of ['attribution', 'head']) {
      if (!evidence.fences?.[label]) {
        problems.push(`${evidence.verdict} evidence lacks the ${label} fence`)
      }
    }
  }
  if (evidence?.verdict === 'BLOCKED' && (!evidence.rungReached || !evidence.blockedReason)) {
    problems.push('BLOCKED lacks rungReached or blockedReason')
  }
  const unfenced = ['preflight', 'fetch'].includes(evidence?.rungReached)
  if (!unfenced && (!evidence?.cloneHeadAtEnd || !evidence?.orcaXHeadAtEnd)) {
    problems.push('cloneHeadAtEnd / orcaXHeadAtEnd missing for a fenced run')
  }
  if (evidence?.verdict === 'BLOCKED' && !unfenced && evidence.cloneLeftAtGatedSha !== true) {
    if (!String(evidence.cloneLeftNote ?? '').includes(ATTRIBUTION_SHA_SHORT)) {
      problems.push(`BLOCKED run left the clone off the gated sha without a cloneLeftNote naming ${ATTRIBUTION_SHA_SHORT}`)
    }
  }
  return { ok: problems.length === 0, problems }
}

function fenceRow(label, fence) {
  if (!fence) {
    return `| ${label} | not run | | | |`
  }
  const v = fence.vitest
  const counts = v ? `total ${v.total}, passed ${v.passed}, failed ${v.failed}, skipped ${v.skipped}` : 'n/a'
  return `| ${label} | ${fence.sha} | ${fence.remoteRevParse ?? 'n/a'} | ${counts} | tsc errors ${fence.tscErrorCount ?? 'n/a'}, files ${fence.vitestFiles ?? 'n/a'} |`
}

export function renderEvidenceMarkdown(e) {
  const list = (items) => (items.length ? items.map((i) => `- ${i}`).join('\n') : '- none')
  const skipped = e.fences?.head?.skippedFiles ?? []
  return `# Phase 7 - federation gates re-measured on GEX44

Verdict: ${e.verdict}${e.verdict === 'MEASURED' ? '' : ` (rung reached: ${e.rungReached}${e.blockedReason ? `; ${e.blockedReason}` : ''})`}.
Gated sha S (gatesFencedSha): ${e.gatesFencedSha}. Serve deployed sha (serveDeployedSha): ${e.serveDeployedSha ?? 'unknown'}; the serve was deliberately not redeployed, so these differ.
Federation head (attribution fence): ${e.federationHead ?? 'unknown'}.

| fence | sha | remote rev-parse | vitest | other |
|---|---|---|---|---|
${fenceRow('attribution', e.fences?.attribution)}
${fenceRow('head', e.fences?.head)}

## Red attribution
Pre-existing red (also red at the attribution fence):
${list(e.attribution.preExistingRed)}

Head-only red (FAIL):
${list(e.attribution.headOnlyRed)}

## Skipped, not passed
Reality tests are skipped with the provider variable unset and are never counted as passed. Skipped files: ${skipped.length ? skipped.join(', ') : 'none recorded'}.

## Clone state at end
cloneHeadAtEnd ${e.cloneHeadAtEnd ?? 'n/a'}, orcaXHeadAtEnd ${e.orcaXHeadAtEnd ?? 'n/a'}.${e.cloneLeftNote ? ` ${e.cloneLeftNote}.` : ''}

## NOT-RERUN
${list(e.notRerun)}

## Correction
${e.correction}

## Named debt
${list(e.inheritedDebt)}

## Evidence commit boundary
${e.evidenceCommitBoundary}
`
}
