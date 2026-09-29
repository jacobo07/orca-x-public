/**
 * DWS-P2 remote process-tree proof (CTX-CLI-4, Task 3). Split out of dws-offload-measurement.mjs
 * to stay under the project's .mjs max-lines cap (600, .oxlintrc.json) -- not a domain boundary,
 * a line-budget one, so this module carries only the ps-capture-transcript parsing and per-leg
 * judgement, nothing else from the measurement instrument.
 *
 * Parses a `ps -o pid,ppid,user,rss,etimes,args --forest -u <svc>` transcript captured by
 * dws-gex44-serve-provision.sh's `ps-capture` subcommand, one or more `CAPTURE <utc>` blocks each
 * followed by that command's real output (header row included). Ancestry is walked via the
 * ppid/pid COLUMNS, never via the forest indentation glyphs (`\_`, `|`) -- those are stripped from
 * the displayed args only, because indentation depth is a rendering detail and pid/ppid is the
 * actual parent-child fact.
 */

const REMOTE_CAPTURE_HEADER_RE = /^CAPTURE\s+(\S+)/
const REMOTE_PS_ROW_RE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(.*)$/

/** Which family a leg's dispatched command shows up as in `ps`'s `args` column (Linux paths). */
const REMOTE_LEG_MATCH = Object.freeze({
  test: (args) => args.includes('vitest.mjs') || args.includes('vitest/vitest.mjs'),
  build: (args) => args.includes('typescript/bin/tsc') || /(^|\/| )tsc(\s|$)/.test(args),
  agent: (args) => /\bclaude\b/.test(args) || /\bcodex\b/.test(args)
})

function parseRemoteCaptureBlocks(captureText) {
  const blocks = []
  let current = null
  for (const line of captureText.split(/\r?\n/)) {
    const captureMatch = REMOTE_CAPTURE_HEADER_RE.exec(line)
    if (captureMatch) {
      current = { utc: captureMatch[1], rows: [] }
      blocks.push(current)
      continue
    }
    if (!current) {
      continue
    }
    const rowMatch = REMOTE_PS_ROW_RE.exec(line)
    if (!rowMatch) {
      continue // header row ("PID PPID USER ...") or a blank line
    }
    const [, pidStr, ppidStr, user, rssStr, etimesStr, rawArgs] = rowMatch
    current.rows.push({
      pid: Number(pidStr),
      ppid: Number(ppidStr),
      user,
      rssKb: Number(rssStr),
      etimes: Number(etimesStr),
      args: rawArgs.replace(/^[\s|\\_]+/, '')
    })
  }
  return blocks
}

function remoteChainReachesPid(row, rowsByPid, targetPid, maxHops = 30) {
  let current = row
  for (let hop = 0; hop < maxHops; hop += 1) {
    if (current.pid === targetPid) {
      return true
    }
    const parent = rowsByPid.get(current.ppid)
    if (!parent || parent.pid === current.pid) {
      return false
    }
    current = parent
  }
  return false
}

// Why: the wrapper's own argv names the leg (`--agent-kind claude`), so it must never count as the leg.
const WORKLOAD_WRAPPER_MARK = 'dws-offload-workload.mjs'
// Slack for etimes' 1s resolution and for LEG-START being stamped just after the spawn.
const LEG_WINDOW_SLACK_MS = 10_000

/** The leg's own identity from its LEG-START marker, or null when the manifest cannot bind it. */
function legBinding(marker) {
  const childPid = Number(marker?.childPid)
  const startMs = Date.parse(marker?.startUtc ?? '')
  if (!Number.isInteger(childPid) || childPid <= 0 || !Number.isFinite(startMs)) {
    return null
  }
  const endMs = Date.parse(marker?.endUtc ?? '')
  return { childPid, startMs, endMs: Number.isFinite(endMs) ? endMs : null }
}

/** A row belongs to this leg only if its process started inside the leg's window. */
function rowStartedInLegWindow(row, blockUtc, binding) {
  const blockMs = Date.parse(blockUtc)
  if (!Number.isFinite(blockMs)) {
    return false
  }
  const rowStartMs = blockMs - row.etimes * 1000
  return (
    rowStartMs >= binding.startMs - LEG_WINDOW_SLACK_MS &&
    (binding.endMs === null || rowStartMs <= binding.endMs + LEG_WINDOW_SLACK_MS)
  )
}

function extractOneLegRemoteProof(leg, blocks, servePid, marker) {
  const matcher = REMOTE_LEG_MATCH[leg]
  const binding = legBinding(marker)
  if (!binding) {
    return { leg, verdict: 'UNJUDGED', reason: 'no LEG-START childPid/startUtc to bind the capture to' }
  }
  let firstSeenUtc = null
  let lastSeenUtc = null
  let peakRssMb = 0
  let sawMatchOutsideTree = false
  let sawStaleMatch = false
  for (const block of blocks) {
    const rowsByPid = new Map(block.rows.map((row) => [row.pid, row]))
    for (const row of block.rows) {
      if (!matcher || !matcher(row.args) || row.args.includes(WORKLOAD_WRAPPER_MARK)) {
        continue
      }
      if (!rowStartedInLegWindow(row, block.utc, binding)) {
        sawStaleMatch = true
        continue
      }
      if (
        remoteChainReachesPid(row, rowsByPid, servePid) &&
        remoteChainReachesPid(row, rowsByPid, binding.childPid)
      ) {
        firstSeenUtc = firstSeenUtc ?? block.utc
        lastSeenUtc = block.utc
        peakRssMb = Math.max(peakRssMb, row.rssKb / 1024)
      } else {
        sawMatchOutsideTree = true
      }
    }
  }
  if (firstSeenUtc) {
    return { leg, verdict: 'PASS', firstSeenUtc, lastSeenUtc, peakRssMb }
  }
  if (sawMatchOutsideTree) {
    return { leg, verdict: 'FAIL', reason: 'not under the serve tree and the leg child' }
  }
  if (sawStaleMatch) {
    return { leg, verdict: 'UNJUDGED', reason: 'only processes started outside the leg window' }
  }
  return { leg, verdict: 'UNJUDGED', reason: 'not captured' }
}

/**
 * `{ leg, verdict, firstSeenUtc?, lastSeenUtc?, peakRssMb?, reason? }[]`, one entry per requested
 * leg. verdict is PASS (matching row's ppid chain reaches servePid), FAIL ("not under the serve
 * tree" -- a matching row exists but never chains to servePid), UNJUDGED ("not captured" -- no
 * matching row in any block; absence of a capture is not absence of the process), or INCONCLUSIVE
 * ("unreadable capture" -- zero CAPTURE blocks in the whole transcript, for every requested leg).
 * A row counts only when it descends from the leg's own `childPid` and started inside its
 * `startUtc`/`endUtc` window (`markers` = the manifest's legs); a leg with no such marker is UNJUDGED.
 */
export function extractRemoteProof(captureText, { servePid, legs, markers = [] }) {
  const blocks = parseRemoteCaptureBlocks(captureText)
  if (blocks.length === 0) {
    return legs.map((leg) => ({ leg, verdict: 'INCONCLUSIVE', reason: 'unreadable capture' }))
  }
  const markerByLeg = new Map(markers.map((marker) => [marker?.leg, marker]))
  return legs.map((leg) => extractOneLegRemoteProof(leg, blocks, servePid, markerByLeg.get(leg)))
}
