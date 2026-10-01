/**
 * DWS-P2 workload manifest: its shape (one validating builder for the local and remote sweeps) and the
 * judgement of whether a sweep ran the same workload as the baseline (CTX-SVC-2, CTX-MEAS-3).
 */

export const WORKLOAD_WRAPPER_PATH = 'config/scripts/dws-offload-workload.mjs'

export const WORKLOAD_BLOB_PATHS = Object.freeze([
  'config/scripts/check-dws-completeness.test.mjs',
  'src/main/runtime/runtime-rpc-websocket-bind-host.test.ts',
  'config/tsconfig.cli.json',
  WORKLOAD_WRAPPER_PATH
])

// Inputs each leg's child process reads; the wrapper's child command lines are fixed in buildChildSpec.
export const CHILD_INPUT_PATHS_BY_LEG = Object.freeze({
  test: Object.freeze([
    'config/scripts/check-dws-completeness.test.mjs',
    'src/main/runtime/runtime-rpc-websocket-bind-host.test.ts'
  ]),
  build: Object.freeze(['config/tsconfig.cli.json']),
  agent: Object.freeze([])
})

const isPositiveInteger = (value) => Number.isInteger(value) && value > 0
const isBlobHash = (value) => typeof value === 'string' && /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(value)

/** Refuses what `summarize` would reject later (a missing desktop root pid), at the write instead. */
export function buildWorkloadManifest(fields) {
  const { desktopRootPid, harnessRootPids = [], nonce, legs, ...rest } = fields ?? {}
  if (!isPositiveInteger(desktopRootPid)) {
    throw new Error(`buildWorkloadManifest: desktopRootPid must be a positive integer (got ${typeof desktopRootPid})`)
  }
  if (!Array.isArray(harnessRootPids) || !harnessRootPids.every(isPositiveInteger)) {
    throw new Error('buildWorkloadManifest: harnessRootPids must be an array of positive integers')
  }
  if (typeof nonce !== 'string' || nonce.length === 0) {
    throw new Error(`buildWorkloadManifest: nonce must be a non-empty string (got ${typeof nonce})`)
  }
  return { desktopRootPid, harnessRootPids, nonce, ...rest, legs }
}

/**
 * Judges comparability only over the inputs the legs that ran actually execute. A missing hash is
 * never equal, an empty checked set is UNJUDGED, and a wrapper difference is recorded, not refused.
 */
export function judgeWorkloadComparability({
  legs,
  baselineBlobHashes,
  offloadBlobHashes,
  baselineCheckoutSha,
  offloadCheckoutSha
}) {
  const wrapperBase = baselineBlobHashes?.[WORKLOAD_WRAPPER_PATH]
  const wrapperOffload = offloadBlobHashes?.[WORKLOAD_WRAPPER_PATH]
  const wrapperMatchesBaseline =
    isBlobHash(wrapperBase) && isBlobHash(wrapperOffload) ? wrapperBase === wrapperOffload : null
  // Only an equal checkout sha proves the transitive src inputs (tsc includes, vitest imports) match.
  const hasShas = isBlobHash(baselineCheckoutSha) && isBlobHash(offloadCheckoutSha)
  const transitiveInputs =
    hasShas && baselineCheckoutSha === offloadCheckoutSha
      ? { verdict: 'IDENTICAL_CHECKOUT' }
      : {
          verdict: 'NOT_COMPARED',
          reason: hasShas
            ? 'checkout shas differ; transitive src inputs not compared'
            : 'checkoutSha missing on baseline or current; transitive src inputs not compared'
        }
  const verdictOf = (verdict, reason, checkedPaths = [], mismatched = []) => ({
    verdict,
    reason,
    checkedPaths,
    mismatched,
    wrapperMatchesBaseline,
    transitiveInputs
  })

  if (!baselineBlobHashes) {
    return verdictOf('UNJUDGED', 'no baseline manifest')
  }
  const unknown = (legs ?? []).filter((leg) => !Object.hasOwn(CHILD_INPUT_PATHS_BY_LEG, leg))
  if (unknown.length > 0) {
    return verdictOf('NOT_COMPARABLE', `unknown leg(s): ${unknown.join(', ')}`)
  }
  const checkedPaths = [...new Set((legs ?? []).flatMap((leg) => CHILD_INPUT_PATHS_BY_LEG[leg]))]
  if (checkedPaths.length === 0) {
    return verdictOf('UNJUDGED', 'the legs that ran have no child-executed inputs to compare')
  }
  const missing = checkedPaths.filter(
    (p) => !isBlobHash(baselineBlobHashes[p]) || !isBlobHash(offloadBlobHashes?.[p])
  )
  if (missing.length > 0) {
    return verdictOf('NOT_COMPARABLE', `hash missing for: ${missing.join(', ')}`, checkedPaths, missing)
  }
  const mismatched = checkedPaths.filter((p) => baselineBlobHashes[p] !== offloadBlobHashes[p])
  if (mismatched.length > 0) {
    return verdictOf('NOT_COMPARABLE', `differs from baseline: ${mismatched.join(', ')}`, checkedPaths, mismatched)
  }
  const wrapperNote =
    wrapperMatchesBaseline === true
      ? 'wrapper identical'
      : `wrapper ${WORKLOAD_WRAPPER_PATH} ${wrapperMatchesBaseline === false ? 'differs (recorded, child command lines not judged)' : 'hash unavailable'}`
  return verdictOf(
    'COMPARABLE',
    `direct child inputs identical for legs ${legs.join(',')}; transitive src inputs not compared; ${wrapperNote}`,
    checkedPaths
  )
}
