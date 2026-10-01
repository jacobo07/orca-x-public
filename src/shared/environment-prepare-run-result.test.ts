import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PREPARE_HOST_REFUSAL_REASONS } from './environment-prepare-run-result'

describe('prepare refusal vocabulary', () => {
  it('mirrors the authority union member for member', () => {
    const source = readFileSync(
      join(__dirname, '..', 'main', 'environment-prepare-authority.ts'),
      'utf8'
    )
    const block = source.match(/export type PrepareRefusalReason =([^]*?)\n\n/)?.[1] ?? ''
    const members = [...block.matchAll(/'([a-z-]+)'/g)].map((match) => match[1])
    expect(members.length).toBeGreaterThan(0)
    expect([...PREPARE_HOST_REFUSAL_REASONS].sort()).toEqual([...members].sort())
  })
})
