import { describe, expect, it } from 'vitest'

import {
  REQUIRED_DIMENSIONS,
  parseGateCommand,
  parseRoadmapPhases,
  verifyMatrix
} from './check-cognitive-workspace-completeness.mjs'

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

const SYNTHETIC_TEST = 'src/synthetic/thing.test.ts'
const SYNTHETIC_TEST_SOURCE = "it('proves the synthetic thing', () => {})"
const SYNTHETIC_DOC = 'docs/synthetic.md'

function syntheticContext(overrides = {}) {
  const sources = new Map([
    [SYNTHETIC_GATE, ''],
    [SYNTHETIC_TEST, SYNTHETIC_TEST_SOURCE],
    [SYNTHETIC_DOC, 'the synthetic contract is written here']
  ])
  return {
    packageScripts: { 'check:synthetic': `node ${SYNTHETIC_GATE}` },
    trackedFiles: new Set(sources.keys()),
    readTracked: (file) => sources.get(file) ?? null,
    reliabilityGateIds: new Set(['synthetic.gate']),
    roadmapPhases: null,
    selfCommandFile: 'config/scripts/check-cognitive-workspace-completeness.mjs',
    ...overrides
  }
}

/** One row replaced, the rest of the complete matrix untouched. */
function withRow(id, patch) {
  const matrix = completeMatrix()
  matrix.rows = matrix.rows.map((row) => (row.id === id ? { ...row, ...patch } : row))
  return matrix
}

const failuresOf = (matrix, context = syntheticContext()) => verifyMatrix(matrix, context).failures

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

  it('fails a duplicated id, an id outside A..T, and a dimension that disagrees with its id', () => {
    const matrix = completeMatrix()
    matrix.rows.push({ ...matrix.rows[0] })
    matrix.rows.push({ ...matrix.rows[1], id: 'Z' })
    matrix.rows[2] = { ...matrix.rows[2], dimension: 'something-else' }
    const failures = failuresOf(matrix)
    expect(failures).toContain('row A appears 2 times')
    expect(
      failures.some((failure) => failure.startsWith('row Z is not a required dimension'))
    ).toBe(true)
    expect(failures).toContain('row C has dimension "something-else", expected "located-effect"')
  })
})

describe('verifyMatrix — evidence kinds', () => {
  it('refuses an unknown evidence kind by name, and resolves a known one', () => {
    expect(failuresOf(withRow('A', { evidence: [{ kind: 'vibes' }] }))).toContain(
      'row A: unknown evidence kind "vibes"'
    )
    expect(
      failuresOf(withRow('A', { evidence: [{ kind: 'gate', script: 'check:synthetic' }] }))
    ).toEqual([])
  })

  it('refuses a test title the file does not contain, and accepts the verbatim one', () => {
    const absent = withRow('A', {
      evidence: [{ kind: 'test', file: SYNTHETIC_TEST, title: 'proves a thing nobody wrote' }]
    })
    expect(
      failuresOf(absent).some((failure) => failure.includes('does not contain the title'))
    ).toBe(true)
    const present = withRow('A', {
      evidence: [{ kind: 'test', file: SYNTHETIC_TEST, title: 'proves the synthetic thing' }]
    })
    expect(failuresOf(present)).toEqual([])
  })

  it('refuses a complete row backed only by doc evidence — existence is not proof', () => {
    const docOnly = withRow('A', {
      evidence: [{ kind: 'doc', file: SYNTHETIC_DOC, contains: 'synthetic contract' }]
    })
    expect(failuresOf(docOnly)).toContain(
      'row A is complete on doc evidence alone; a complete row needs evidence that is not a document'
    )
    const open = withRow('A', {
      state: 'open',
      closes: 'when it is proven',
      evidence: [{ kind: 'doc', file: SYNTHETIC_DOC, contains: 'synthetic contract' }]
    })
    expect(failuresOf(open)).toEqual([])
  })

  it('refuses a complete row with no evidence at all', () => {
    expect(failuresOf(withRow('A', { evidence: [] }))).toContain(
      'row A is complete with no evidence'
    )
  })

  it('refuses a doc pointer whose text is gone, even on an open row', () => {
    const rotted = withRow('A', {
      state: 'open',
      closes: 'later',
      evidence: [{ kind: 'doc', file: SYNTHETIC_DOC, contains: 'a sentence that was deleted' }]
    })
    expect(failuresOf(rotted).some((failure) => failure.includes('does not contain'))).toBe(true)
  })

  it('refuses a gate missing from package.json, a non-node command, and the verifier as its own evidence', () => {
    const context = syntheticContext({
      packageScripts: {
        'check:synthetic': `node ${SYNTHETIC_GATE}`,
        'check:shell': 'rm -rf /',
        'check:self': 'node config/scripts/check-cognitive-workspace-completeness.mjs --integrity'
      }
    })
    const missing = failuresOf(
      withRow('A', { evidence: [{ kind: 'gate', script: 'check:nope' }] }),
      context
    )
    const shell = failuresOf(
      withRow('A', { evidence: [{ kind: 'gate', script: 'check:shell' }] }),
      context
    )
    const self = failuresOf(
      withRow('A', { evidence: [{ kind: 'gate', script: 'check:self' }] }),
      context
    )
    expect(missing).toContain('row A: gate script "check:nope" is not in package.json')
    expect(shell.some((failure) => failure.includes('is not a plain'))).toBe(true)
    expect(self.some((failure) => failure.includes('cannot be its own evidence'))).toBe(true)
  })

  it('refuses a product-reality rung outside the five, and counts valid rungs', () => {
    const bad = withRow('A', {
      evidence: [
        {
          kind: 'product-reality',
          spec: SYNTHETIC_TEST,
          title: 'proves the synthetic thing',
          rung: 'vibes'
        }
      ]
    })
    expect(failuresOf(bad).some((failure) => failure.includes('rung "vibes"'))).toBe(true)
    const good = withRow('A', {
      evidence: [
        {
          kind: 'product-reality',
          spec: SYNTHETIC_TEST,
          title: 'proves the synthetic thing',
          rung: 'real-electron'
        }
      ]
    })
    const result = verifyMatrix(good, syntheticContext())
    expect(result.failures).toEqual([])
    expect(result.aperture.rungs).toEqual({ 'real-electron': 1 })
  })

  it('resolves a reliability-gate id that exists and refuses one that does not', () => {
    const present = withRow('A', { evidence: [{ kind: 'reliability-gate', id: 'synthetic.gate' }] })
    const absent = withRow('A', {
      evidence: [{ kind: 'reliability-gate', id: 'nobody.wrote.this' }]
    })
    expect(failuresOf(present)).toEqual([])
    expect(failuresOf(absent)).toContain(
      'row A: reliability gate "nobody.wrote.this" is not in config/reliability-gates.jsonc'
    )
  })

  it('refuses an owner path that is not tracked, and accepts a sentence owner', () => {
    expect(failuresOf(withRow('A', { owner: 'src/deleted/owner.ts' }))).toContain(
      'row A names owner src/deleted/owner.ts, which is not tracked'
    )
    expect(failuresOf(withRow('A', { owner: 'Phase 3 creates this authority' }))).toEqual([])
  })
})

describe('verifyMatrix — blocked is narrow', () => {
  it('refuses a blocker class that is really engineering', () => {
    const matrix = withRow('T', {
      state: 'blocked',
      evidence: [],
      blocker: { class: 'engineering', precondition: 'someone writes the code' }
    })
    expect(
      failuresOf(matrix).some((failure) => failure.includes('only owner-auth and runner-capacity'))
    ).toBe(true)
  })

  it('refuses an allowed blocker with no precondition, and accepts one with a precondition', () => {
    const silent = withRow('T', {
      state: 'blocked',
      evidence: [],
      blocker: { class: 'runner-capacity', precondition: '' }
    })
    expect(failuresOf(silent)).toContain('row T is blocked without a precondition sentence')
    const stated = withRow('T', {
      state: 'blocked',
      evidence: [],
      blocker: { class: 'runner-capacity', precondition: 'a runner is assigned' }
    })
    expect(failuresOf(stated)).toEqual([])
  })
})

describe('verifyMatrix — phases and the roadmap cross-check', () => {
  it('refuses a row whose phase is not in the phases table', () => {
    expect(failuresOf(withRow('A', { phase: '7' }))).toContain(
      'row A names phase "7", which is not in the phases table'
    )
  })

  it('refuses a phases table that disagrees with the roadmap, both directions and by title', () => {
    const matrix = completeMatrix()
    matrix.phases = [
      { number: '1', title: 'Only phase' },
      { number: '2', title: 'Renamed here' }
    ]
    const roadmapPhases = new Map([
      ['1', 'Only phase'],
      ['2', 'Named there'],
      ['3', 'Only in the roadmap']
    ])
    const failures = failuresOf(matrix, syntheticContext({ roadmapPhases }))
    expect(failures).toContain(
      'phase 2 is titled "Renamed here" in the matrix but "Named there" in the roadmap'
    )
    expect(failures).toContain(
      'phase 3 ("Only in the roadmap") is in the roadmap but not in the matrix'
    )
  })

  it('passes and says NOT RUN when there is no roadmap to cross-check', () => {
    const result = verifyMatrix(completeMatrix(), syntheticContext({ roadmapPhases: null }))
    expect(result.failures).toEqual([])
    expect(result.aperture.roadmapCrossCheck).toBe('not-run')
  })

  it('passes and says it ran when the roadmap agrees', () => {
    const result = verifyMatrix(
      completeMatrix(),
      syntheticContext({ roadmapPhases: new Map([['1', 'Only phase']]) })
    )
    expect(result.failures).toEqual([])
    expect(result.aperture.roadmapCrossCheck).toBe('ran')
  })
})

describe('parseRoadmapPhases', () => {
  it('reads open, done and decimal checklist phases and ignores detail headings', () => {
    const text = [
      '## Phases',
      '- [ ] **Phase 1: First thing** - does a thing',
      '- [x] **Phase 2: Second thing** - done already',
      '- [ ] **Phase 2.1: Inserted thing** - urgent',
      '### Phase 3: A heading, not a checklist entry'
    ].join('\n')
    expect([...parseRoadmapPhases(text)]).toEqual([
      ['1', 'First thing'],
      ['2', 'Second thing'],
      ['2.1', 'Inserted thing']
    ])
  })
})

describe('parseGateCommand', () => {
  it('accepts a plain node gate with simple arguments and nothing else', () => {
    expect(parseGateCommand('node config/scripts/x.mjs --integrity')).toEqual({
      file: 'config/scripts/x.mjs',
      args: ['--integrity']
    })
    expect(parseGateCommand('node config/scripts/x.mjs && curl evil')).toBeNull()
    expect(parseGateCommand('pnpm run something')).toBeNull()
  })
})
