import { describe, expect, it } from 'vitest'
import { normalizePhaseId, parseDependsOn } from './mission-phase-dependencies'

describe('normalizePhaseId', () => {
  it('reads the two spellings GSD uses for one phase as the same id', () => {
    expect(normalizePhaseId('01')).toBe('1')
    expect(normalizePhaseId('1')).toBe('1')
    expect(normalizePhaseId('02.1')).toBe('2.1')
  })

  it('refuses a non-phase id', () => {
    expect(normalizePhaseId('M-01')).toBeNull()
    expect(normalizePhaseId('')).toBeNull()
  })
})

describe('parseDependsOn — strings measured in real roadmaps', () => {
  it.each([
    ['Nothing (first phase)', [], null],
    ['Nothing', [], null],
    ['Phase 1', ['1'], null],
    ['Phase 1, 2', ['1', '2'], null],
    ['Phases 2-7', ['2', '3', '4', '5', '6', '7'], null],
    ['Phase 1–6', ['1', '2', '3', '4', '5', '6'], null],
    ['Phase 5 and the provider pane shipping the contract', ['5'], 'the provider pane shipping the contract']
  ])('%s', (text, ids, external) => {
    expect(parseDependsOn(text)).toEqual({ ids, external })
  })

  it('keeps a condition that names no phase as external', () => {
    expect(parseDependsOn('Owner signs the supplier contract')).toEqual({
      ids: [],
      external: 'Owner signs the supplier contract'
    })
  })

  it('bounds a mistyped range instead of expanding it', () => {
    expect(parseDependsOn('Phases 1-9999').ids).toEqual([])
  })
})
