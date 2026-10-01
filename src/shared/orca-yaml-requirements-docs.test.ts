import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EVALUATED_REQUIREMENT_KINDS } from './environment-requirement-types'
import { parseOrcaYamlRequirements } from './orca-yaml-requirements'

const doc = readFileSync(join(__dirname, '../../docs/reference/orca-yaml-requirements.md'), 'utf8')
const authorityPath = join(__dirname, '../main/environment-prepare-authority.ts')
const authorityExists = existsSync(authorityPath)

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

  it('the kinds marked LIVE are the evaluated kinds, plus prepare once its authority exists', () => {
    const live = kindRows()
      .filter((row) => row.status === 'LIVE')
      .map((row) => row.kind)
      .sort()
    const expected: string[] = [...EVALUATED_REQUIREMENT_KINDS]
    if (authorityExists) {
      expected.push('prepare')
    }
    expect(live).toEqual(expected.sort())
  })

  it('prepare is LIVE iff the authority that enforces it exists', () => {
    expect(kindRows().find((row) => row.kind === 'prepare')?.status).toBe(
      authorityExists ? 'LIVE' : 'PLANNED'
    )
  })

  // The doc claim and its enforcement land together: each sentence exists iff the authority does.
  it.each([
    ['Only approved prepare commands run', /only approved prepare commands run/i],
    ['the runtime-host sentence', /the grant itself is the caller's, not recorded host-side/],
    ['the unreadable approval refusal', /approval-unreadable/],
    ['the check-to-spawn window', /Window: between the final re-read/]
  ])('%s appears iff the authority exists', (_label, pattern) => {
    expect(pattern.test(doc)).toBe(authorityExists)
  })

  it.runIf(authorityExists)('names every refusal reason the authority can return', () => {
    const authority = readFileSync(authorityPath, 'utf8')
    const union = /export type PrepareRefusalReason =([\s\S]*?)\n\n/.exec(authority)
    const reasons = [...(union?.[1] ?? '').matchAll(/'([a-z-]+)'/g)].map((match) => match[1])
    expect(reasons.length).toBeGreaterThan(5)
    for (const reason of reasons) {
      expect(doc, reason).toContain(reason)
    }
  })
})
