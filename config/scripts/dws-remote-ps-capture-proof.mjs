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

function extractOneLegRemoteProof(leg, blocks, servePid) {
  const matcher = REMOTE_LEG_MATCH[leg]
  let firstSeenUtc = null
  let lastSeenUtc = null
  let peakRssMb = 0
  let sawMatchOutsideTree = false
  for (const block of blocks) {
    const rowsByPid = new Map(block.rows.map((row) => [row.pid, row]))
    for (const row of block.rows) {
      if (!matcher || !matcher(row.args)) {
        continue
      }
      if (remoteChainReachesPid(row, rowsByPid, servePid)) {
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
    return { leg, verdict: 'FAIL', reason: 'not under the serve tree' }
  }
  return { leg, verdict: 'UNJUDGED', reason: 'not captured' }
}

/**
 * `{ leg, verdict, firstSeenUtc?, lastSeenUtc?, peakRssMb?, reason? }[]`, one entry per requested
 * leg. verdict is PASS (matching row's ppid chain reaches servePid), FAIL ("not under the serve
 * tree" -- a matching row exists but never chains to servePid), UNJUDGED ("not captured" -- no
 * matching row in any block; absence of a capture is not absence of the process), or INCONCLUSIVE
 * ("unreadable capture" -- zero CAPTURE blocks in the whole transcript, for every requested leg).
 */
export function extractRemoteProof(captureText, { servePid, legs }) {
  const blocks = parseRemoteCaptureBlocks(captureText)
  if (blocks.length === 0) {
    return legs.map((leg) => ({ leg, verdict: 'INCONCLUSIVE', reason: 'unreadable capture' }))
  }
  return legs.map((leg) => extractOneLegRemoteProof(leg, blocks, servePid))
}
