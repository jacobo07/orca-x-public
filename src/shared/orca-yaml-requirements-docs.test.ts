import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EVALUATED_REQUIREMENT_KINDS } from './environment-requirement-types'
import { parseOrcaYamlRequirements } from './orca-yaml-requirements'

const doc = readFileSync(join(__dirname, '../../docs/reference/orca-yaml-requirements.md'), 'utf8')

function kindRows(): { kind: string; status: string }[] {
  return doc
    .split(/\r?\n/)
    .filter((line) => line.startsWith('|'))
    .map((line) => line.split('|').map((cell) => cell.trim()))
    .filter((cells) => /^`[a-z]+`$/.test(cells[1] ?? ''))
    .map((cells) => ({ kind: cells[1].replace(/`/g, ''), status: cells[2] }))
}

describe('docs/reference/orca-yaml-requirements.md', () => {
  it('is marked experimental', () => {
    expect(doc).toMatch(/Status: experimental/)
  })

  it('first yaml example parses with zero diagnostics', () => {
    const fence = /```yaml\r?\n([\s\S]*?)```/.exec(doc)
    expect(fence).not.toBeNull()
    const result = parseOrcaYamlRequirements(fence![1])
    expect(result.status).toBe('parsed')
    if (result.status === 'parsed') {
      expect(result.diagnostics).toEqual([])
      expect(result.requirements.length).toBeGreaterThan(0)
      expect(result.requirements.some((r) => 'unsupportedByThisOrca' in r)).toBe(true)
      expect(result.requirements.some((r) => 'malformed' in r)).toBe(false)
    }
  })

  it('example covers every evaluated kind', () => {
    const fence = /```yaml\r?\n([\s\S]*?)```/.exec(doc)!
    const result = parseOrcaYamlRequirements(fence[1])
    const kinds = new Set(result.status === 'parsed' ? result.requirements.map((r) => r.kind) : [])
    for (const kind of EVALUATED_REQUIREMENT_KINDS) {
      expect(kinds.has(kind)).toBe(true)
    }
  })

  it('every kind row has exactly one of LIVE, PLANNED or ABSENT', () => {
    const rows = kindRows()
    expect(rows.length).toBeGreaterThanOrEqual(EVALUATED_REQUIREMENT_KINDS.length)
    for (const row of rows) {
      expect(['LIVE', 'PLANNED', 'ABSENT'], `status of ${row.kind}`).toContain(row.status)
    }
    expect(new Set(rows.map((r) => r.kind)).size).toBe(rows.length)
  })

  it('the kinds marked LIVE are exactly the evaluated kinds', () => {
    const live = kindRows()
      .filter((row) => row.status === 'LIVE')
      .map((row) => row.kind)
      .sort()
    expect(live).toEqual([...EVALUATED_REQUIREMENT_KINDS].sort())
  })

  it('prepare is PLANNED in this plan', () => {
    expect(kindRows().find((row) => row.kind === 'prepare')?.status).toBe('PLANNED')
  })

  it('does not claim that prepare commands run', () => {
    expect(doc).not.toMatch(/only approved prepare commands run/i)
  })
})
