import { describe, expect, it } from 'vitest'

import { REQUIRED_DIMENSIONS, verifyMatrix } from './check-cognitive-workspace-completeness.mjs'

// The subjects here are SYNTHETIC. A drill pinned to the real matrix would stop asserting anything
// the day its example row changed state; these represent the class and cannot be fixed out from
// under the test. The fixture is built independently of the verifier so it cannot inherit its bugs.

const SYNTHETIC_GATE = 'config/scripts/synthetic-gate.mjs'
const DIMENSIONS = [
  'agent-identity',
  'project-ownership',
  'located-effect',
  'provider-instruction-layer',
  'provider-execution-location',
  'conversation-durability',
  'remote-execution',
  'multi-project-safety',
  'worktree-dirty-state',
  'user-facing-states',
  'cli-ipc-frontend-coherence',
  'security',
  'observability',
  'token-economics',
  'failure-recovery',
  'device-independent-projection',
  'product-reality',
  'baseline-inheritance',
  'knowledge-ukdl',
  'ci'
]

function completeMatrix() {
  return {
    schemaVersion: 1,
    program: 'synthetic',
    phases: [{ number: '1', title: 'Only phase' }],
    rows: DIMENSIONS.map((dimension, index) => ({
      id: String.fromCharCode(65 + index),
      dimension,
      owner: SYNTHETIC_GATE,
      state: 'complete',
      phase: '1',
      claim: `synthetic claim for ${dimension}`,
      evidence: [{ kind: 'gate', script: 'check:synthetic' }]
    }))
  }
}

function syntheticContext(overrides = {}) {
  return {
    packageScripts: { 'check:synthetic': `node ${SYNTHETIC_GATE}` },
    trackedFiles: new Set([SYNTHETIC_GATE]),
    selfCommandFile: 'config/scripts/check-cognitive-workspace-completeness.mjs',
    ...overrides
  }
}

describe('verifyMatrix — required dimensions', () => {
  it('passes a matrix that carries every dimension on resolving evidence', () => {
    // The GREEN control: a detector that flagged everything would satisfy every red case below.
    expect(verifyMatrix(completeMatrix(), syntheticContext()).failures).toEqual([])
  })

  it('fails a matrix that dropped a required dimension, naming it', () => {
    const matrix = completeMatrix()
    matrix.rows = matrix.rows.filter((row) => row.id !== 'K')
    const { failures } = verifyMatrix(matrix, syntheticContext())
    expect(failures).toContain('missing required dimension K (cli-ipc-frontend-coherence)')
  })

  it('keeps the dimension list in the verifier, twenty strong', () => {
    expect(REQUIRED_DIMENSIONS.map((dimension) => dimension.key)).toEqual(DIMENSIONS)
  })
})
