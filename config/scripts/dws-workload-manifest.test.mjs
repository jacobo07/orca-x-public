import { describe, expect, it } from 'vitest'
import {
  CHILD_INPUT_PATHS_BY_LEG,
  WORKLOAD_BLOB_PATHS,
  WORKLOAD_WRAPPER_PATH,
  buildWorkloadManifest,
  judgeWorkloadComparability
} from './dws-workload-manifest.mjs'
import { buildObservation } from './dws-offload-observation.mjs'

const NONCE = '0123456789abcdef'
const BIND_HOST_TEST = 'src/main/runtime/runtime-rpc-websocket-bind-host.test.ts'

// The field set the remote spec wrote before 02-07: no desktopRootPid.
const OLD_REMOTE_FIELDS = {
  nonce: NONCE,
  checkoutSha: 'a'.repeat(40),
  checkout: '/srv/checkout',
  envName: 'gex44-svc',
  environmentId: 'env-1',
  blobHashes: {},
  legs: []
}

function hashesFor(seed) {
  return Object.fromEntries(
    WORKLOAD_BLOB_PATHS.map((blobPath, index) => [blobPath, String(index + seed).padEnd(40, 'a')])
  )
}

describe('buildWorkloadManifest', () => {
  it('refuses the old remote field set, naming desktopRootPid', () => {
    expect(() => buildWorkloadManifest(OLD_REMOTE_FIELDS)).toThrow(/desktopRootPid/)
  })

  it.each([0, -1, 1.5, '123', null, undefined])('refuses desktopRootPid %j', (desktopRootPid) => {
    expect(() => buildWorkloadManifest({ ...OLD_REMOTE_FIELDS, desktopRootPid })).toThrow(/desktopRootPid/)
  })

  it.each([[[0]], [[-3]], [[1.5]], [['7']], ['12']])('refuses harnessRootPids %j', (harnessRootPids) => {
    expect(() =>
      buildWorkloadManifest({ ...OLD_REMOTE_FIELDS, desktopRootPid: 4242, harnessRootPids })
    ).toThrow(/harnessRootPids/)
  })

  it.each([undefined, '', 5])('refuses nonce %j', (nonce) => {
    expect(() => buildWorkloadManifest({ ...OLD_REMOTE_FIELDS, desktopRootPid: 4242, nonce })).toThrow(/nonce/)
  })

  it('carries the pid, defaults harnessRootPids and keeps every extra field', () => {
    const comparability = { verdict: 'COMPARABLE' }
    const built = buildWorkloadManifest({ ...OLD_REMOTE_FIELDS, desktopRootPid: 4242, comparability })
    expect(built).toMatchObject({
      desktopRootPid: 4242,
      harnessRootPids: [],
      nonce: NONCE,
      checkout: '/srv/checkout',
      envName: 'gex44-svc',
      environmentId: 'env-1',
      blobHashes: {},
      comparability,
      legs: []
    })
  })

  it('never accepts a manifest that summarize would reject', () => {
    const built = buildWorkloadManifest({ ...OLD_REMOTE_FIELDS, desktopRootPid: 4242, harnessRootPids: [11, 12] })
    const observation = buildObservation([], {
      desktopRootPid: built.desktopRootPid,
      sawStart: true,
      sawStop: true,
      legWindow: null
    })
    expect(observation.desktopRootPidValid).toBe(true)
  })
})

describe('judgeWorkloadComparability', () => {
  const same = hashesFor(1)

  it('is COMPARABLE when every hash matches', () => {
    const result = judgeWorkloadComparability({
      legs: ['test', 'build'],
      baselineBlobHashes: same,
      offloadBlobHashes: { ...same }
    })
    expect(result).toMatchObject({ verdict: 'COMPARABLE', wrapperMatchesBaseline: true })
  })

  it('records a wrapper-only difference without refusing or calling it identical', () => {
    const result = judgeWorkloadComparability({
      legs: ['test', 'build'],
      baselineBlobHashes: same,
      offloadBlobHashes: { ...same, [WORKLOAD_WRAPPER_PATH]: 'b'.repeat(40) }
    })
    expect(result.verdict).toBe('COMPARABLE')
    expect(result.wrapperMatchesBaseline).toBe(false)
    expect(result.reason).toContain(WORKLOAD_WRAPPER_PATH)
  })

  it('refuses when the bind-host test differs and the test leg ran', () => {
    const result = judgeWorkloadComparability({
      legs: ['test', 'build'],
      baselineBlobHashes: same,
      offloadBlobHashes: { ...same, [BIND_HOST_TEST]: 'c'.repeat(40) }
    })
    expect(result.verdict).toBe('NOT_COMPARABLE')
    expect(result.mismatched).toContain(BIND_HOST_TEST)
  })

  it('admits the same difference when only the build leg ran', () => {
    const result = judgeWorkloadComparability({
      legs: ['build'],
      baselineBlobHashes: same,
      offloadBlobHashes: { ...same, [BIND_HOST_TEST]: 'c'.repeat(40) }
    })
    expect(result.verdict).toBe('COMPARABLE')
  })

  it('never treats a path missing on both sides as equal', () => {
    const hashes = { ...same }
    delete hashes[BIND_HOST_TEST]
    const result = judgeWorkloadComparability({
      legs: ['test'],
      baselineBlobHashes: hashes,
      offloadBlobHashes: { ...hashes }
    })
    expect(result.verdict).toBe('NOT_COMPARABLE')
    expect(result.reason).toContain('missing')
  })

  it('is UNJUDGED without a baseline and for an agent-only sweep', () => {
    expect(
      judgeWorkloadComparability({ legs: ['test'], baselineBlobHashes: null, offloadBlobHashes: same })
    ).toMatchObject({ verdict: 'UNJUDGED', reason: expect.stringContaining('no baseline manifest') })
    expect(
      judgeWorkloadComparability({ legs: ['agent'], baselineBlobHashes: same, offloadBlobHashes: same })
    ).toMatchObject({ verdict: 'UNJUDGED' })
  })

  it('names an unknown leg', () => {
    const result = judgeWorkloadComparability({
      legs: ['test', 'bogus'],
      baselineBlobHashes: same,
      offloadBlobHashes: same
    })
    expect(result.verdict).toBe('NOT_COMPARABLE')
    expect(result.reason).toContain('bogus')
  })

  it('says only direct child inputs were compared, never that all child inputs are identical', () => {
    const result = judgeWorkloadComparability({
      legs: ['test', 'build'],
      baselineBlobHashes: same,
      offloadBlobHashes: { ...same }
    })
    expect(result.reason).toContain('direct child inputs identical for legs test,build')
    expect(result.reason).toContain('transitive src inputs not compared')
    expect(result.reason).not.toMatch(/(^|; )child inputs identical/)
  })

  it('reports transitive inputs IDENTICAL_CHECKOUT only when both checkout shas exist and are equal', () => {
    const args = { legs: ['test', 'build'], baselineBlobHashes: same, offloadBlobHashes: { ...same } }
    const sha = 'a'.repeat(40)
    expect(
      judgeWorkloadComparability({ ...args, baselineCheckoutSha: sha, offloadCheckoutSha: sha })
        .transitiveInputs
    ).toEqual({ verdict: 'IDENTICAL_CHECKOUT' })
  })

  it.each([
    ['differ', 'a'.repeat(40), 'b'.repeat(40)],
    ['baseline missing', undefined, 'b'.repeat(40)],
    ['offload missing', 'a'.repeat(40), undefined],
    ['both missing', undefined, undefined]
  ])('reports transitive inputs NOT_COMPARED when checkout shas %s', (_name, base, offload) => {
    const result = judgeWorkloadComparability({
      legs: ['test', 'build'],
      baselineBlobHashes: same,
      offloadBlobHashes: { ...same },
      baselineCheckoutSha: base,
      offloadCheckoutSha: offload
    })
    expect(result.verdict).toBe('COMPARABLE')
    expect(result.transitiveInputs.verdict).toBe('NOT_COMPARED')
    expect(result.transitiveInputs.reason).toEqual(expect.any(String))
  })

  it('carries transitiveInputs on non-COMPARABLE verdicts too', () => {
    const result = judgeWorkloadComparability({ legs: ['test'], baselineBlobHashes: null, offloadBlobHashes: same })
    expect(result.transitiveInputs.verdict).toBe('NOT_COMPARED')
  })

  it('exposes the per-leg child inputs frozen', () => {
    expect(Object.isFrozen(CHILD_INPUT_PATHS_BY_LEG)).toBe(true)
    expect(CHILD_INPUT_PATHS_BY_LEG.agent).toEqual([])
    expect(CHILD_INPUT_PATHS_BY_LEG.test).toContain(BIND_HOST_TEST)
  })
})
