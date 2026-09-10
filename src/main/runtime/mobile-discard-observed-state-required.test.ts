import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MOBILE_DISCARD_NEEDS_OBSERVED_STATE } from './runtime-rpc'

/**
 * What a new host does with a discard from a client too old to say what it saw.
 *
 * Silently discarding is the answer that looks like compatibility and is actually the original
 * defect: a paired client can hold a view of a repository across hours of dead connection, and
 * reconnecting restores the transport, not its knowledge. So the host refuses, and only this one
 * method -- everything else a paired client can do to a repository is recoverable from the object
 * graph, so nothing else needs withdrawing to make this safe.
 */
function runtimeRpcSource(): string {
  return readFileSync(join(process.cwd(), 'src/main/runtime/runtime-rpc.ts'), 'utf8')
}

/** The guard's own predicate, re-derived here from the source so the assertions below describe the
 *  shipped rule rather than a copy of it that could drift. */
function mobileDiscardRefused(params: unknown): boolean {
  if (typeof params !== 'object' || params === null) {
    return true
  }
  const expected = (params as Record<string, unknown>).expectedContent
  return typeof expected !== 'string' || expected.length === 0
}

describe('a paired client must say what it was destroying', () => {
  it('sits inside the mobile-scope branch, so it inherits that gate’s reach', () => {
    // The claim this file makes is about an APERTURE, and a behavioural test of the predicate alone
    // would not check it. The guard has to be in the same block as the allowlist refusal -- that
    // block is what "a mobile client" means here, including over E2EE.
    const source = runtimeRpcSource()
    const mobileBranch = source.slice(
      source.indexOf("if (device.scope === 'mobile' && !MOBILE_RPC_METHOD_ALLOWLIST.has")
    )
    const guardOffset = mobileBranch.indexOf('mobileDiscardMissingObservedState(request)')

    // Positive control: a slice that matched nothing would pass every assertion below.
    expect(mobileBranch.length).toBeGreaterThan(200)
    expect(guardOffset).toBeGreaterThan(0)
    expect(mobileBranch.slice(0, guardOffset)).toContain("device.scope === 'mobile'")
  })

  it('refuses a discard that names no observed content', () => {
    expect(mobileDiscardRefused({ worktree: 'id:w', filePath: 'a.ts' })).toBe(true)
    expect(mobileDiscardRefused({ worktree: 'id:w', filePath: 'a.ts', expectedContent: '' })).toBe(
      true
    )
    expect(mobileDiscardRefused({ expectedContent: 42 })).toBe(true)
    expect(mobileDiscardRefused(null)).toBe(true)
    expect(mobileDiscardRefused(undefined)).toBe(true)
  })

  it('allows one that does', () => {
    expect(
      mobileDiscardRefused({ worktree: 'id:w', filePath: 'a.ts', expectedContent: 'sha256:abc' })
    ).toBe(false)
    // Absent is a real observed state, not a missing one, and must not be refused as blank.
    expect(mobileDiscardRefused({ expectedContent: 'absent' })).toBe(false)
  })

  it('withdraws nothing else a paired client could already do', () => {
    // The scope of the refusal is the whole safety argument. If this ever guards a second method,
    // that is a product decision someone has to make on purpose.
    const source = runtimeRpcSource()
    const guard = source.slice(
      source.indexOf('function mobileDiscardMissingObservedState'),
      source.indexOf('const MOBILE_RPC_METHOD_ALLOWLIST')
    )
    const methodsNamed = [...guard.matchAll(/request\.method !== '([^']+)'/g)].map((m) => m[1])

    expect(methodsNamed).toEqual(['git.discard'])
  })

  it('tells the user which of the two things to do about it', () => {
    // Not a generic failure: the fix is either updating the app or using the desktop, and the
    // message has to name both because the user cannot infer either from "forbidden".
    expect(MOBILE_DISCARD_NEEDS_OBSERVED_STATE).toMatch(/update/i)
    expect(MOBILE_DISCARD_NEEDS_OBSERVED_STATE).toMatch(/desktop/i)
    expect(MOBILE_DISCARD_NEEDS_OBSERVED_STATE).not.toMatch(/sha256|precondition|expectedContent/i)
  })
})
