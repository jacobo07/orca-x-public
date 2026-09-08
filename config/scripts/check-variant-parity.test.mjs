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
    'unknown'
  ],
  evidenceRequiredFor: ['shared-already', 'ported', 'equivalent'],
  reasonRequiredFor: ['desktop-only', 'not-applicable', 'superseded', 'blocked'],
  invariantRequiredFor: ['equivalent']
}

function manifestOf(capabilities) {
  return { policy: POLICY, capabilities }
}

const acceptAllPaths = () => true

function run(capabilities, { baseline = [], knownPath = acceptAllPaths } = {}) {
  return evaluateManifest({ manifest: manifestOf(capabilities), baseline, knownPath })
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

  it('ignores comments and blank lines in the baseline', () => {
    expect(parseBaseline('# note\n\n a.one \nb.two\n')).toEqual(['a.one', 'b.two'])
  })

  // Positive control: the shipped manifest must actually pass, or every red above is theatre.
  it('accepts the manifest this repository ships', async () => {
    const root = path.resolve(import.meta.dirname, '..', '..')
    const manifest = parse(await fs.readFile(path.join(root, 'config/variant-parity.jsonc'), 'utf8'))
    const baseline = parseBaseline(
      await fs.readFile(path.join(root, 'config/variant-parity-unknown-baseline.txt'), 'utf8')
    )
    const result = evaluateManifest({
      manifest,
      baseline,
      knownPath: (reference) => existsSync(path.join(root, reference))
    })
    expect(result.problems).toEqual([])
    expect(result.verdict).toBe(VERDICT.ok)
    expect(manifest.capabilities.length).toBeGreaterThan(10)
  })
})
