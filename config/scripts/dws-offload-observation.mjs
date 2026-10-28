/**
 * DWS-P2 run-validity judgement: whether a sampled run was observed at all, and whether its
 * workload legs actually succeeded. Split out of dws-offload-measurement.mjs to stay under the .mjs
 * max-lines cap -- a line-budget boundary; that module re-exports everything public here.
 */

/** Fewer samples than this cannot show a run was observed at all (the sampler runs at ~1s cadence). */
export const MIN_OBSERVED_SAMPLES = 3
const LEG_WINDOW_TOLERANCE_MS = 5000

/**
 * The window the manifest's legs spanned, as epoch ms, from the legs that carry both stamps. Null
 * when none does (a TIMEOUT leg has no endUtc) -- "unknown", never a fabricated window.
 */
export function legWindowFromManifest(manifest) {
  const legs = Array.isArray(manifest?.legs) ? manifest.legs : []
  const starts = []
  const ends = []
  for (const leg of legs) {
    const startMs = Date.parse(leg?.startUtc ?? '')
    const endMs = Date.parse(leg?.endUtc ?? '')
    if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
      starts.push(startMs)
      ends.push(endMs)
    }
  }
  return starts.length > 0 ? { startMs: Math.min(...starts), endMs: Math.max(...ends) } : null
}

/** Legs that ended but whose LEG-START was never captured; legWindowFromManifest silently drops them. */
export function unboundLegsFromManifest(manifest) {
  const legs = Array.isArray(manifest?.legs) ? manifest.legs : []
  return legs
    .filter((leg) => Number.isFinite(Date.parse(leg?.endUtc ?? '')) && !Number.isFinite(Date.parse(leg?.startUtc ?? '')))
    .map((leg) => leg.leg ?? 'unknown')
}

/**
 * A leg counts only if its workload actually succeeded: exit 0, and for `agent` a matched reply. A
 * crashed leg frees RAM too, so its tiny delta would otherwise read as an absence PASS (WR-06).
 */
export function judgeLegMarker(marker) {
  const leg = marker?.leg ?? 'unknown'
  if (marker?.exit !== '0') {
    const cause = leg === 'agent' && marker?.agentReply ? ` agentReply=${marker.agentReply}` : ''
    return { leg, verdict: 'FAILED', reason: `exit=${marker?.exit ?? 'missing'}${cause}` }
  }
  if (leg === 'agent' && marker.agentReply !== 'matched') {
    return { leg, verdict: 'FAILED', reason: `agentReply=${marker.agentReply ?? 'missing'}` }
  }
  return { leg, verdict: 'OK' }
}

/** The manifest's legs that did not succeed; `null` when the manifest carries no legs[] at all. */
export function failedLegsFromManifest(manifest) {
  if (!Array.isArray(manifest?.legs)) {
    return null
  }
  return manifest.legs.map(judgeLegMarker).filter((v) => v.verdict === 'FAILED')
}

/** Remote proof may not PASS a leg whose workload failed: its presence under serve proves nothing. */
export function applyLegOutcomes(proofs, manifestLegs) {
  const byLeg = new Map((manifestLegs ?? []).map((marker) => [marker?.leg, judgeLegMarker(marker)]))
  return proofs.map((proof) => {
    const outcome = byLeg.get(proof.leg) ?? judgeLegMarker({ leg: proof.leg })
    return outcome.verdict === 'FAILED'
      ? { ...proof, verdict: 'FAIL', reason: `leg workload FAILED (${outcome.reason})` }
      : proof
  })
}

export function buildObservation(
  samples,
  { desktopRootPid, sawStart, sawStop, legWindow, failedLegs = null, unboundLegs = [] }
) {
  const utcMs = samples.map((s) => Date.parse(s.utc ?? '')).filter(Number.isFinite)
  const monoMs = samples.map((s) => s.monoMs).filter((v) => typeof v === 'number')
  const firstMs = utcMs.length > 0 ? Math.min(...utcMs) : null
  const lastMs = utcMs.length > 0 ? Math.max(...utcMs) : null
  let legWindowCovered = null
  if (legWindow) {
    legWindowCovered =
      firstMs !== null &&
      lastMs !== null &&
      firstMs <= legWindow.startMs + LEG_WINDOW_TOLERANCE_MS &&
      lastMs >= legWindow.endMs - LEG_WINDOW_TOLERANCE_MS
  }
  // A dropped leg leaves the window narrower than the run, so "covered" is unknown (null), never true.
  if (unboundLegs.length > 0 && legWindowCovered === true) {
    legWindowCovered = null
  }
  return {
    samples: samples.length,
    sawStart,
    sawStop,
    spanMs: monoMs.length > 1 ? Math.max(...monoMs) - Math.min(...monoMs) : 0,
    desktopRootPidValid: Number.isInteger(desktopRootPid) && desktopRootPid > 0,
    legWindowCovered,
    failedLegs,
    ...(unboundLegs.length > 0 ? { unboundLegs } : {})
  }
}

/**
 * Why a run cannot be judged: empty, truncated or unattributable sample streams. A summary with no
 * `observation` record is a defect too -- an unknown observation is not a clean one. Every entry is
 * a reason to answer INCONCLUSIVE rather than PASS/OK (a run that was never observed reads exactly
 * like a run in which nothing happened). The CLI passes `ignoreDesktopPid` for its exit code only:
 * the sampler self-test legitimately has no desktop, but every verdict still counts the pid.
 */
export function observationDefects(summary, { ignoreDesktopPid = false } = {}) {
  const obs = summary?.observation
  if (!obs) {
    return ['no observation record (summary predates the validity checks, or was hand-built)']
  }
  const defects = []
  if (!(obs.samples >= MIN_OBSERVED_SAMPLES)) {
    defects.push(`only ${obs.samples ?? 0} sample(s) (< ${MIN_OBSERVED_SAMPLES})`)
  }
  if (obs.sawStart !== true) {
    defects.push('sampler-start record missing')
  }
  if (obs.sawStop !== true) {
    defects.push('sampler-stop record missing (the sampler may have died mid-run)')
  }
  if (obs.legWindowCovered === false) {
    defects.push('sample stream does not cover the legs window (truncated)')
  }
  for (const leg of Array.isArray(obs.unboundLegs) ? obs.unboundLegs : []) {
    defects.push(`leg ${leg}: LEG-START not observed (startUtc/childPid missing); leg window unbound`)
  }
  if (Array.isArray(obs.failedLegs) && obs.failedLegs.length > 0) {
    defects.push(`workload leg(s) failed: ${obs.failedLegs.map((f) => `${f.leg} ${f.reason}`).join(', ')}`)
  }
  if (summary.freeMb?.before == null || summary.freeMb?.after == null) {
    defects.push('free-memory bracket missing')
  }
  if (!ignoreDesktopPid && obs.desktopRootPidValid !== true) {
    defects.push('manifest desktopRootPid is not a positive integer')
  }
  return defects
}
