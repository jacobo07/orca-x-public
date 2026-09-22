import { describe, expect, it } from 'vitest'
import { provenExactResume } from './proven-exact-resume'
import type { WorkingSetFactPresence } from './project-working-set-store-types'

/**
 * The predicate two transitions share. What is worth pinning is not that `present`+`present` is
 * true — it is that nothing ELSE is, because every way a probe can fail to answer arrives here as
 * `unknown`, and a promise made on `unknown` is the defect this whole line of work exists to stop.
 */

const PRESENCES: (WorkingSetFactPresence | null)[] = ['present', 'absent', 'unknown', null]

describe('provenExactResume', () => {
  it('proves an exact resume only when both facts were observed present', () => {
    expect(provenExactResume('present', 'present')).toBe(true)
  })

  it('refuses every other pair, so unknown never reads as proof', () => {
    const promised = PRESENCES.flatMap((transcript) =>
      (['present', 'absent', 'unknown'] as const)
        .filter((location) => provenExactResume(transcript, location))
        .map((location) => `${transcript}/${location}`)
    )
    // The whole grid, so a predicate widened to `!== 'absent'` cannot pass by naming one case.
    expect(promised).toEqual(['present/present'])
  })

  it('treats a pane that captured no session as unproven rather than as a missing transcript', () => {
    expect(provenExactResume(null, 'present')).toBe(false)
  })
})
