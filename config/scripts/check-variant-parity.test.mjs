import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { parse } from 'jsonc-parser'

import { VERDICT, evaluateManifest, parseBaseline } from './check-variant-parity.mjs'

const POLICY = {
  variants: ['desktop', 'mobile'],
  dispositions: [
    'shared-already',
    'ported',
    'equivalent',
    'desktop-only',
    'not-applicable',
    'superseded',
    'blocked',
    'measured-open',
    'unknown'
  ],
  evidenceRequiredFor: ['shared-already', 'ported', 'equivalent', 'measured-open'],
  reasonRequiredFor: ['desktop-only', 'not-applicable', 'superseded', 'blocked', 'measured-open'],
  invariantRequiredFor: ['equivalent'],
  unresolvedDispositions: ['unknown', 'measured-open'],
  severities: ['P0', 'P1', 'P2', 'P3']
}

function manifestOf(capabilities) {
  return { policy: POLICY, capabilities }
}

const acceptAllPaths = () => true

function run(
  capabilities,
  { baseline = [], measuredOpenBaseline = [], knownPath = acceptAllPaths } = {}
) {
  return evaluateManifest({
    manifest: manifestOf(capabilities),
    baseline,
    measuredOpenBaseline,
    knownPath
  })
}

/** A measured-open row that satisfies every field requirement, so a test can vary one thing. */
function measuredOpen(overrides = {}) {
  return {
    id: 'a.measured',
    title: 'measured and open',
    disposition: 'measured-open',
    evidence: ['mobile/src/thing.test.ts'],
    reason: 'the host projects it but the client cannot read it yet',
    severity: 'P1',
    ...overrides
  }
}

describe('variant parity gate', () => {
  it('accepts a capability that claims parity and cites evidence', () => {
    const result = run([
      {
        id: 'a.shared',
        title: 'shared thing',
        disposition: 'shared-already',
        evidence: ['mobile/src/thing.test.ts']
      }
    ])
    expect(result.verdict).toBe(VERDICT.ok)
    expect(result.problems).toEqual([])
  })

  it('accepts a mobile equivalent that names the invariant it preserves', () => {
    const result = run([
      {
        id: 'a.equivalent',
        title: 'different presentation, same guarantee',
        disposition: 'equivalent',
        evidence: ['mobile/src/thing.test.ts'],
        invariant: 'the transcript belongs to the input that started recording'
      }
    ])
    expect(result.verdict).toBe(VERDICT.ok)
  })

  it('rejects a parity claim that cites nothing', () => {
    const result = run([{ id: 'a.bare', title: 'bare claim', disposition: 'shared-already' }])
    expect(result.verdict).toBe(VERDICT.subjectInvalid)
    expect(result.problems[0].message).toContain('must cite evidence')
  })

  it('rejects an equivalent that does not say what it preserves', () => {
    const result = run([
      {
        id: 'a.vague',
        title: 'vague equivalent',
        disposition: 'equivalent',
        evidence: ['mobile/src/thing.test.ts']
      }
    ])
    expect(result.verdict).toBe(VERDICT.subjectInvalid)
    expect(result.problems.some((problem) => problem.message.includes('invariant'))).toBe(true)
  })

  it('rejects an excuse with no reason', () => {
    const result = run([{ id: 'a.excuse', title: 'excused', disposition: 'not-applicable' }])
    expect(result.verdict).toBe(VERDICT.subjectInvalid)
    expect(result.problems[0].message).toContain('must give a reason')
  })

  it('rejects a blocked capability with no owner', () => {
    const result = run([
      { id: 'a.blocked', title: 'blocked', disposition: 'blocked', reason: 'needs a device' }
    ])
    expect(result.verdict).toBe(VERDICT.subjectInvalid)
    expect(result.problems.some((problem) => problem.message.includes('owner'))).toBe(true)
  })

  it('rejects a disposition outside the policy', () => {
    const result = run([{ id: 'a.odd', title: 'odd', disposition: 'probably-fine' }])
    expect(result.verdict).toBe(VERDICT.subjectInvalid)
    expect(result.problems[0].message).toContain('is not one of')
  })

  // The ratchet, in both directions.
  it('fails a NEW unclassified capability while grandfathering an old one', () => {
    const capabilities = [
      { id: 'old.debt', title: 'old', disposition: 'unknown' },
      { id: 'new.debt', title: 'new', disposition: 'unknown' }
    ]
    const result = run(capabilities, { baseline: ['old.debt'] })
    expect(result.verdict).toBe(VERDICT.subjectInvalid)
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0].id).toBe('new.debt')
  })

  it('fails a baseline entry that is no longer unclassified, so the list cannot go stale', () => {
    const result = run(
      [
        {
          id: 'was.debt',
          title: 'resolved',
          disposition: 'ported',
          evidence: ['mobile/src/thing.test.ts']
        }
      ],
      { baseline: ['was.debt'] }
    )
    expect(result.verdict).toBe(VERDICT.subjectInvalid)
    expect(result.problems[0].message).toContain('may only shrink')
  })

  it('fails evidence that no longer exists, so a deleted proof cannot keep a claim alive', () => {
    const result = run(
      [
        {
          id: 'a.stale',
          title: 'stale evidence',
          disposition: 'ported',
          evidence: ['mobile/src/deleted.test.ts']
        }
      ],
      { knownPath: () => false }
    )
    expect(result.verdict).toBe(VERDICT.subjectInvalid)
    expect(result.problems[0].message).toContain('does not exist')
  })

  it('reports an unreadable manifest as unreadable, not as a failing subject', () => {
    const result = evaluateManifest({
      manifest: { capabilities: [] },
      baseline: [],
      knownPath: acceptAllPaths
    })
    expect(result.verdict).toBe(VERDICT.unreadableInput)
  })

  /**
   * The guard for unanticipated inputs cannot be driven with anticipated ones, so this needs a shape
   * the JSONC source could never produce. Without it, a checker that had quietly stopped isolating
   * failures would report the same clean green as one that still does.
   */
  it('reports its own failure as verifier-failed rather than blaming the capability', () => {
    const hostile = {
      title: 'throws when read',
      disposition: 'unknown',
      get id() {
        throw new Error('unreadable id')
      }
    }
    const result = run([hostile])
    expect(result.verdict).toBe(VERDICT.verifierFailed)
    expect(result.problems[0].message).toContain('checker threw')
  })

  /**
   * The two debt axes.
   *
   * "unknown" and "measured-open" are both unresolved and they are not the same state: one says
   * nobody looked, the other says someone looked and named the gap. Collapsing them loses the
   * difference between work that needs investigation and work that needs implementing. Separating
   * them creates a new hazard instead -- relabelling as progress -- so every test below is really
   * asking one of two questions: can the two states be told apart, and can moving between them
   * make the debt look smaller than it is.
   */
  describe('measured-open debt', () => {
    it('accepts a gap that says what was measured, what remains, and how bad it is', () => {
      const result = run([measuredOpen()], { measuredOpenBaseline: ['a.measured'] })
      expect(result.verdict).toBe(VERDICT.ok)
      expect(result.problems).toEqual([])
    })

    it('rejects a measured-open gap that measured nothing', () => {
      const result = run([measuredOpen({ evidence: undefined })], {
        measuredOpenBaseline: ['a.measured']
      })
      expect(result.verdict).toBe(VERDICT.subjectInvalid)
      expect(result.problems.some((problem) => problem.message.includes('cite evidence'))).toBe(true)
    })

    it('rejects a measured-open gap that does not say why it is still open', () => {
      const result = run([measuredOpen({ reason: undefined })], {
        measuredOpenBaseline: ['a.measured']
      })
      expect(result.verdict).toBe(VERDICT.subjectInvalid)
      expect(result.problems.some((problem) => problem.message.includes('reason'))).toBe(true)
    })

    it('rejects a severity outside the policy, so the release gate cannot be fed a made-up one', () => {
      const result = run([measuredOpen({ severity: 'urgent' })], {
        measuredOpenBaseline: ['a.measured']
      })
      expect(result.verdict).toBe(VERDICT.subjectInvalid)
      expect(result.problems.some((problem) => problem.message.includes('severity'))).toBe(true)
    })

    // The same ratchet the unknown list has, in both directions -- otherwise the new disposition is
    // simply a place to put debt where nothing counts it.
    it('fails a NEW measured-open gap that nobody acknowledged', () => {
      const result = run([measuredOpen()], { measuredOpenBaseline: [] })
      expect(result.verdict).toBe(VERDICT.subjectInvalid)
      expect(result.problems.some((problem) => problem.id === 'a.measured')).toBe(true)
    })

    it('fails a measured-open baseline entry that is no longer open', () => {
      const result = run(
        [{ id: 'was.open', title: 'closed', disposition: 'ported', evidence: ['mobile/src/t.ts'] }],
        { measuredOpenBaseline: ['was.open'] }
      )
      expect(result.verdict).toBe(VERDICT.subjectInvalid)
      expect(result.problems[0].message).toContain('may only shrink')
    })

    it('refuses to count one capability as two kinds of debt at once', () => {
      const result = run([{ id: 'both.lists', title: 'both', disposition: 'unknown' }], {
        baseline: ['both.lists'],
        measuredOpenBaseline: ['both.lists']
      })
      expect(result.verdict).toBe(VERDICT.subjectInvalid)
      expect(result.problems.some((problem) => problem.message.includes('both'))).toBe(true)
    })
  })

  /**
   * Reclassifying an unknown into a measured-open gap is real progress -- we know something we did
   * not know. It is not progress toward shipping, and the count must say so. If the unresolved
   * total falls when a row moves between the two lists, the metric rewards relabelling and the
   * whole distinction becomes a way to look finished.
   */
  describe('debt accounting', () => {
    it('does not shrink the unresolved total when a row moves from unknown to measured-open', () => {
      const before = run(
        [
          { id: 'a.one', title: 'one', disposition: 'unknown' },
          { id: 'a.two', title: 'two', disposition: 'unknown' }
        ],
        { baseline: ['a.one', 'a.two'] }
      )
      const after = run(
        [
          { id: 'a.one', title: 'one', disposition: 'unknown' },
          measuredOpen({ id: 'a.two', title: 'two' })
        ],
        { baseline: ['a.one'], measuredOpenBaseline: ['a.two'] }
      )

      expect(before.verdict).toBe(VERDICT.ok)
      expect(after.verdict).toBe(VERDICT.ok)
      expect(before.debt.unknown).toBe(2)
      expect(after.debt.unknown).toBe(1)
      expect(after.debt.measuredOpen).toBe(1)
      expect(after.debt.unresolved).toBe(before.debt.unresolved)
    })

    it('counts an unresolved capability with no severity as P0, never as harmless', () => {
      // Absence is the least-capability answer here: an untriaged gap is treated as the worst it
      // could be, so forgetting the field can only ever make the release gate stricter.
      const result = run([{ id: 'a.untriaged', title: 'untriaged', disposition: 'unknown' }], {
        baseline: ['a.untriaged']
      })
      expect(result.verdict).toBe(VERDICT.ok)
      expect(result.debt.p0Unresolved).toEqual(['a.untriaged'])
      expect(result.debt.releaseReady).toBe(false)
    })

    it('is release-ready only when no unresolved capability is release-critical', () => {
      const result = run(
        [
          measuredOpen({ id: 'a.minor', severity: 'P2' }),
          { id: 'a.later', title: 'later', disposition: 'unknown', severity: 'P3' }
        ],
        { baseline: ['a.later'], measuredOpenBaseline: ['a.minor'] }
      )
      expect(result.debt.p0Unresolved).toEqual([])
      expect(result.debt.releaseReady).toBe(true)
    })

    it('names the release-critical gaps rather than only counting them', () => {
      const result = run(
        [
          measuredOpen({ id: 'a.bad', severity: 'P0' }),
          measuredOpen({ id: 'a.fine', severity: 'P2' })
        ],
        { measuredOpenBaseline: ['a.bad', 'a.fine'] }
      )
      expect(result.debt.p0Unresolved).toEqual(['a.bad'])
      expect(result.debt.releaseReady).toBe(false)
    })

    it('reports a resolved capability as no debt at all', () => {
      const result = run([
        { id: 'a.done', title: 'done', disposition: 'ported', evidence: ['mobile/src/t.ts'] }
      ])
      expect(result.debt.unresolved).toBe(0)
      expect(result.debt.releaseReady).toBe(true)
    })
  })

  it('ignores comments and blank lines in the baseline', () => {
    expect(parseBaseline('# note\n\n a.one \nb.two\n')).toEqual(['a.one', 'b.two'])
  })

  // Positive control: the shipped manifest must actually pass, or every red above is theatre.
  it('accepts the manifest this repository ships', async () => {
    const root = path.resolve(import.meta.dirname, '..', '..')
    const manifest = parse(await fs.readFile(path.join(root, 'config/variant-parity.jsonc'), 'utf8'))
    const readBaseline = async (file) =>
      parseBaseline(await fs.readFile(path.join(root, file), 'utf8'))
    const result = evaluateManifest({
      manifest,
      baseline: await readBaseline('config/variant-parity-unknown-baseline.txt'),
      measuredOpenBaseline: await readBaseline('config/variant-parity-measured-open-baseline.txt'),
      knownPath: (reference) => existsSync(path.join(root, reference))
    })
    expect(result.problems).toEqual([])
    expect(result.verdict).toBe(VERDICT.ok)
    expect(manifest.capabilities.length).toBeGreaterThan(10)
    // The two axes must add up on the real manifest, not only on fixtures -- a row counted twice or
    // dropped would otherwise surface first as a debt total nobody could reconcile.
    expect(result.debt.unresolved).toBe(result.debt.unknown + result.debt.measuredOpen)
  })
})
