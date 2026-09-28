import { describe, expect, it } from 'vitest'
import { composeReviewSpec, parseReviewFindings, parseReviewReply } from './review-findings'

const fence = (body: string) => '```json\n' + body + '\n```'

describe('parseReviewReply', () => {
  it('reads a verdict and findings, and says whether they block', () => {
    const reply = `Looks mostly fine.\n${fence(
      JSON.stringify({
        schema: 'orca.review-findings/1',
        verdict: 'approve',
        findings: [{ severity: 'minor', summary: 'rename x', location: 'a.ts:3' }]
      })
    )}`

    expect(parseReviewReply(reply)).toEqual({
      schema: 'orca.review-findings/1',
      kind: 'structured',
      verdict: 'approve',
      findings: [{ severity: 'minor', summary: 'rename x', location: 'a.ts:3' }],
      blocking: false
    })
  })

  it('blocks on a blocker finding even under an approving verdict', () => {
    const reply = fence(JSON.stringify({ verdict: 'approve', findings: [{ severity: 'blocker', summary: 'drops data' }] }))

    expect(parseReviewReply(reply)).toMatchObject({ kind: 'structured', blocking: true })
  })

  it('takes the last block, so a quoted example earlier in the reply is not the answer', () => {
    const reply = [
      fence(JSON.stringify({ verdict: 'approve', findings: [] })),
      'Actually, on reflection:',
      fence(JSON.stringify({ verdict: 'changes-requested', findings: [] }))
    ].join('\n')

    expect(parseReviewReply(reply)).toMatchObject({ verdict: 'changes-requested', blocking: true })
  })

  it('never turns a reply that ignored the contract into a verdict', () => {
    expect(parseReviewReply('LGTM!')).toMatchObject({ kind: 'unstructured', problem: 'no-json-block' })
    expect(parseReviewReply(fence('{nope'))).toMatchObject({ kind: 'unstructured', problem: 'json-unparseable' })
    expect(parseReviewReply(fence('{"verdict":"ship-it","findings":[]}'))).toMatchObject({ problem: 'verdict-missing' })
    expect(parseReviewReply(fence('{"verdict":"approve"}'))).toMatchObject({ problem: 'findings-missing' })
    expect(
      parseReviewReply(fence('{"verdict":"approve","findings":[{"severity":"catastrophic","summary":"x"}]}'))
    ).toMatchObject({ problem: 'finding-malformed' })
  })
})

describe('the review spec and its stored form', () => {
  it('shows the reviewer the exact patch and its fingerprint', () => {
    const spec = composeReviewSpec({ projectId: 'p', revision: 'abc', patchHash: 'h1', patch: '+added line' })

    expect(spec).toContain('+added line')
    expect(spec).toContain('sha256 h1')
    expect(spec).toContain('abc')
  })

  it('reads back only its own schema', () => {
    expect(parseReviewFindings(JSON.stringify(parseReviewReply('LGTM')))).toMatchObject({ kind: 'unstructured' })
    expect(parseReviewFindings('{"schema":"other"}')).toBeNull()
    expect(parseReviewFindings('not json')).toBeNull()
    expect(parseReviewFindings(null)).toBeNull()
  })
})
