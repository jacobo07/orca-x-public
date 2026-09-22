import { describe, expect, it } from 'vitest'
import { SCOPE_SOURCE } from './ci-repo-scope.mjs'
import { CAPACITY, STARVATION_BOUNDARY, classifyCapacity, formatVerdict } from './report-ci-capacity.mjs'

// Measured on jacobo07/orca-x 2026-09-22T14:06Z, nine days past the boundary: run 35738019166,
// job "Linux X11 terminal IME", runner_id 0, 0 steps, conclusion "failure". That red tick is what
// this reporter exists to stop anyone reading as a test result.

const AFTER = '2026-09-22T14:06:38Z'
const BEFORE = '2026-09-12T10:00:00Z'

const ran = (id = 4001) => ({ name: 'e2e', runner_id: id, steps: [{ conclusion: 'success' }] })
const starved = () => ({ name: 'e2e', runner_id: 0, steps: [], conclusion: 'failure' })
const skipped = () => ({ name: 'badge', runner_id: null, steps: [], conclusion: 'skipped' })
/** A runner ran it but no steps came back: a shape the classifier refuses to resolve either way. */
const weird = () => ({ name: 'odd', runner_id: 7, steps: [] })

const run = (jobs, createdAt = AFTER, id = 1) => ({ id, name: 'wf', createdAt, jobs })

describe('has execution capacity returned for this repository', () => {
  it('reports RESTORED only on positive evidence that a machine ran something', () => {
    const result = classifyCapacity({ runs: [run([starved()]), run([ran(4242)], AFTER, 2)] })
    expect(result.verdict).toBe(CAPACITY.RESTORED)
    expect(result.reason).toContain('runner 4242')
    expect(result.evidence.firstExecutedRunId).toBe(2)
  })

  it('reports NOT_RESTORED when jobs asked for a machine and none arrived', () => {
    const result = classifyCapacity({ runs: [run([starved(), starved()])] })
    expect(result.verdict).toBe(CAPACITY.NOT_RESTORED)
    expect(result.evidence.counts).toMatchObject({ executed: 0, starved: 2 })
  })

  // The mutation this kills: treating a skipped job as starvation. A skipped job requests no
  // runner, so it is evidence about a workflow condition and none at all about capacity.
  it('does NOT turn an all-skipped window into starvation', () => {
    const result = classifyCapacity({ runs: [run([skipped(), skipped()])] })
    expect(result.verdict).toBe(CAPACITY.UNKNOWN)
    expect(result.reason).toMatch(/condition-skipped/)
  })

  it('still reports NOT_RESTORED when skipped jobs sit beside starved ones', () => {
    expect(classifyCapacity({ runs: [run([skipped(), starved()])] }).verdict).toBe(
      CAPACITY.NOT_RESTORED
    )
  })

  // The mutation this kills: crediting execution from BEFORE capacity disappeared. Every repository
  // has healthy history; reading it through the boundary declares every outage over.
  it('ignores execution that predates the boundary', () => {
    const result = classifyCapacity({ runs: [run([ran()], BEFORE), run([starved()], AFTER, 2)] })
    expect(result.verdict).toBe(CAPACITY.NOT_RESTORED)
    expect(result.evidence.examined).toBe(1)
  })

  it('is UNKNOWN when nothing has been created since the boundary', () => {
    const result = classifyCapacity({ runs: [run([ran()], BEFORE)] })
    expect(result.verdict).toBe(CAPACITY.UNKNOWN)
    expect(result.reason).toMatch(/no runs were created after/)
  })

  // An unreadable run is a HOLE in the evidence. Counting it as starved would manufacture a
  // confident outage out of a failed API call.
  it('keeps an unreadable run apart from an observed one', () => {
    const result = classifyCapacity({ runs: [run(null), run(null, AFTER, 2)] })
    expect(result.verdict).toBe(CAPACITY.UNKNOWN)
    expect(result.evidence.unreadable).toBe(2)
    expect(result.reason).toMatch(/could not be read/)
  })

  it('is UNKNOWN on a job shape it does not recognise', () => {
    const result = classifyCapacity({ runs: [run([weird()])] })
    expect(result.verdict).toBe(CAPACITY.UNKNOWN)
    expect(result.reason).toMatch(/does not recognise/)
  })

  it('is UNKNOWN when a run reports no jobs, and when the boundary is unreadable', () => {
    expect(classifyCapacity({ runs: [run([])] }).verdict).toBe(CAPACITY.UNKNOWN)
    expect(classifyCapacity({ runs: [run([ran()])], boundary: 'never' }).verdict).toBe(
      CAPACITY.UNKNOWN
    )
  })

  // The boundary is the FIRST OBSERVED STARVATION, read from the recovery contract. It was once a
  // constant copied from a note that wrote local CEST time as UTC; the API says the last run that
  // executed was created 2026-09-12T23:51:28Z and the first starved one 2026-09-13T10:43:50Z.
  it('defaults to the first observed starvation, and credits nothing before it', () => {
    expect(STARVATION_BOUNDARY).toBe('2026-09-13T10:43:50Z')
    expect(classifyCapacity({ runs: [run([ran()], STARVATION_BOUNDARY)] }).verdict).toBe(
      CAPACITY.RESTORED
    )
    // A run executing in the unobserved ten hours happened before capacity was lost. Under the old
    // 01:51Z constant this read as RESTORED.
    const window = '2026-09-13T05:00:00Z'
    expect(classifyCapacity({ runs: [run([ran()], window)] }).verdict).toBe(CAPACITY.UNKNOWN)
    expect(classifyCapacity({ runs: [run([ran()], window), run([starved()])] }).verdict).toBe(
      CAPACITY.NOT_RESTORED
    )
  })
})

describe('a capacity verdict names its subject', () => {
  // An answer about stablyai/orca cannot answer a question about jacobo07/orca-x, and the two are
  // indistinguishable once the repository is off the page.
  it('prints the repository and how it was resolved beside the verdict', () => {
    const scope = { repo: 'jacobo07/orca-x', source: SCOPE_SOURCE.ORIGIN_REMOTE }
    const text = formatVerdict(
      scope,
      STARVATION_BOUNDARY,
      classifyCapacity({ runs: [run([starved()])] })
    )
    expect(text).toContain('repo jacobo07/orca-x (resolved from origin remote)')
    expect(text).toContain(`boundary ${STARVATION_BOUNDARY}`)
    expect(text).toContain('examined 1 run(s)')
    expect(text).toContain(`CAPACITY ${CAPACITY.NOT_RESTORED}`)
  })
})
