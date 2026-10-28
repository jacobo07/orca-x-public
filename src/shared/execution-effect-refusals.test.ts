import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CANCEL_WORKSTREAM_REFUSAL_CODES,
  STOP_EXECUTION_REFUSAL_CODES,
  UWCP_CONTROL_CONTRACT,
  WORKSTREAM_AUTHORITY_UNAVAILABLE
} from './execution-effect-refusals'

function intersection(a: readonly string[], b: readonly string[]): string[] {
  return a.filter((code) => b.includes(code))
}

describe('execution effect refusal vocabularies', () => {
  it('freezes the Stop Execution vocabulary at the codes the runtime already ships', () => {
    expect(Object.isFrozen(STOP_EXECUTION_REFUSAL_CODES)).toBe(true)
    expect([...STOP_EXECUTION_REFUSAL_CODES].sort()).toEqual(
      [
        'remote_runtime_unavailable',
        'terminal_exact_stop_failed',
        'terminal_exact_stop_requires_single_pty',
        'terminal_exact_stop_unavailable',
        'terminal_handle_stale',
        'terminal_liveness_unavailable',
        'terminal_stop_pty_set_mismatch'
      ].sort()
    )
  })

  it('freezes the Cancel Workstream vocabulary at its single authority refusal', () => {
    expect(Object.isFrozen(CANCEL_WORKSTREAM_REFUSAL_CODES)).toBe(true)
    expect([...CANCEL_WORKSTREAM_REFUSAL_CODES]).toEqual(['workstream_authority_unavailable'])
    expect(WORKSTREAM_AUTHORITY_UNAVAILABLE).toBe('workstream_authority_unavailable')
    expect(UWCP_CONTROL_CONTRACT).toBe('uwcp.control/1')
  })

  it('keeps the two vocabularies disjoint, and the helper can see an overlap', () => {
    expect(intersection(STOP_EXECUTION_REFUSAL_CODES, CANCEL_WORKSTREAM_REFUSAL_CODES)).toEqual([])
    // Positive control: a synthetic pair sharing one code must be reported.
    expect(intersection(['a', 'shared'], ['shared', 'b'])).toEqual(['shared'])
  })

  it('names only Stop codes that still exist in the runtime or client source', () => {
    const root = process.cwd()
    const source =
      readFileSync(join(root, 'src/main/runtime/orca-runtime.ts'), 'utf8') +
      readFileSync(join(root, 'src/shared/remote-runtime-client.ts'), 'utf8')
    const missing = STOP_EXECUTION_REFUSAL_CODES.filter((code) => !source.includes(`'${code}'`))
    expect(missing).toEqual([])
    // Station control: the sweep does fail for a code that is not there.
    expect(source.includes(`'not_a_real_stop_code'`)).toBe(false)
  })
})
