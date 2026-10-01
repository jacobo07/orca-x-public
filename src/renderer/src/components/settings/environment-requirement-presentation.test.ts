import { describe, expect, it } from 'vitest'
import { PREPARE_HOST_REFUSAL_REASONS } from '../../../../shared/environment-prepare-run-result'
import type { RequirementState } from '../../../../shared/environment-requirement-state'
import {
  presentPrepareRefusal,
  presentRequirementReason,
  presentRequirementState
} from './environment-requirement-presentation'

const STATES: RequirementState[] = [
  'satisfied',
  'missing',
  'incompatible',
  'unsupported',
  'needs-authorization',
  'unknown'
]

describe('presentRequirementState', () => {
  it('gives every state a label and only satisfied the success tone', () => {
    for (const state of STATES) {
      const presented = presentRequirementState(state)
      expect(presented.label.length).toBeGreaterThan(0)
      expect(presented.tone === 'success').toBe(state === 'satisfied')
    }
  })

  it('keeps unknown and unsupported neutral', () => {
    expect(presentRequirementState('unknown').tone).toBe('neutral')
    expect(presentRequirementState('unsupported').tone).toBe('neutral')
  })
})

describe('presentRequirementReason', () => {
  it('names the unreachable and too-old hosts in words', () => {
    expect(presentRequirementReason('unreachable')).toBe('Host unreachable')
    expect(presentRequirementReason('host-predates-probes')).toContain('too old')
  })

  it('never prints a code it does not describe', () => {
    const text = presentRequirementReason('some-new-probe-reason')
    expect(text).not.toContain('some-new-probe-reason')
    expect(text.length).toBeGreaterThan(0)
  })
})

describe('presentPrepareRefusal', () => {
  it('describes every host refusal and both client refusals without printing the code', () => {
    for (const reason of [
      ...PREPARE_HOST_REFUSAL_REASONS,
      'host-predates-prepare',
      'unreachable'
    ] as const) {
      const text = presentPrepareRefusal(reason)
      expect(text.length).toBeGreaterThan(0)
      expect(text).not.toBe(reason)
    }
  })
})
