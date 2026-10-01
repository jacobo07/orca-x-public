/**
 * Pure BACKFILL verdict for the DWS-P2 web-client reattach (CTX-CONT-2), split out of
 * dws-web-client-reattach.mjs so the verdict can be driven with synthetic buffers (that script
 * imports playwright and runs main() on load).
 *
 * The claim is "output produced while NO client was attached is replayed to a client that attaches
 * afterwards". A single `max visible tick > tick at quit` cannot prove that: the tick loop keeps
 * running, so any live tick emitted after the client attached is also greater than the tick at quit,
 * and a client that received no replay at all would pass. So the check is about the unattached
 * window itself: (lQuitExit, lAttach0], i.e. ticks emitted after the old desktop process was
 * observed gone and before the new client navigated. The serialized buffer must hold a hole-free run
 * of those ticks ending at lAttach0 (the newest tick that existed before the client attached).
 *
 * Verdicts: PASS / FAIL / INCONCLUSIVE. INCONCLUSIVE covers everything the instrument could not
 * establish (reader not live, a bound missing) and is never turned into PASS.
 */

export function extractTickSet(content, nonce) {
  const ticks = new Set()
  const re = new RegExp(`DWS-TICK-${nonce}-(\\d+)`, 'g')
  let match = re.exec(content ?? '')
  while (match) {
    ticks.add(Number(match[1]))
    match = re.exec(content ?? '')
  }
  return ticks
}

export function parseTickLine(line, nonce) {
  const match = new RegExp(`DWS-TICK-${nonce}-(\\d+)`).exec(line ?? '')
  return match ? Number(match[1]) : null
}

/**
 * @param {{content: string, nonce: string, lQuitExit: number|null, lAttach0: number|null, readerLive: boolean}} input
 */
export function judgeBackfill({ content, nonce, lQuitExit, lAttach0, readerLive }) {
  if (!readerLive) {
    return {
      verdict: 'INCONCLUSIVE',
      reason:
        'reader did not validate as live (two reads >= 2s apart did not show the tick number growing)'
    }
  }
  if (!Number.isInteger(lQuitExit)) {
    return {
      verdict: 'INCONCLUSIVE',
      reason:
        'continuity.json carries no tick recorded after the desktop process exited (tQuitExitLine); the unattached window is unknown'
    }
  }
  if (!Number.isInteger(lAttach0)) {
    return {
      verdict: 'INCONCLUSIVE',
      reason: 'could not parse a tick number from the remote tail read just before attaching'
    }
  }
  if (lAttach0 <= lQuitExit) {
    return {
      verdict: 'INCONCLUSIVE',
      reason: `no tick was emitted while unattached (tick at quit exit ${lQuitExit}, tick before attach ${lAttach0}); nothing to back-fill`
    }
  }

  const ticks = extractTickSet(content, nonce)
  const inWindow = [...ticks].filter((n) => n > lQuitExit && n <= lAttach0).sort((a, b) => a - b)
  const window = { lQuitExit, lAttach0, visibleInWindow: inWindow.length }

  if (inWindow.length === 0) {
    return {
      verdict: 'FAIL',
      reason: `none of the ${lAttach0 - lQuitExit} tick(s) emitted while unattached (${lQuitExit + 1}..${lAttach0}) are visible; highest visible was ${ticks.size > 0 ? Math.max(...ticks) : 'none'}`,
      ...window
    }
  }
  if (!ticks.has(lAttach0)) {
    return {
      verdict: 'FAIL',
      reason: `tick ${lAttach0} existed before the client attached but is not visible (replay incomplete at its newest end)`,
      ...window
    }
  }
  const missing = []
  for (let n = inWindow[0]; n <= lAttach0; n += 1) {
    if (!ticks.has(n)) {
      missing.push(n)
    }
  }
  if (missing.length > 0) {
    return {
      verdict: 'FAIL',
      reason: `gap in the replayed unattached ticks ${inWindow[0]}..${lAttach0}: missing ${missing.slice(0, 10).join(',')}${missing.length > 10 ? ',...' : ''}`,
      ...window,
      missingCount: missing.length
    }
  }
  // Scrollback may have pruned the oldest unattached ticks; that is recorded, not hidden.
  const truncatedAtOldestEnd = inWindow[0] > lQuitExit + 1
  return {
    verdict: 'PASS',
    reason: `ticks ${inWindow[0]}..${lAttach0} (all emitted while no client was attached, after tick ${lQuitExit}) are visible with no gap${
      truncatedAtOldestEnd ? `; ticks ${lQuitExit + 1}..${inWindow[0] - 1} were not visible (scrollback)` : ''
    }`,
    ...window,
    truncatedAtOldestEnd
  }
}
