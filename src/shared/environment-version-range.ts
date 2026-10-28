import type { RequirementVersionRange, VersionComparator } from './environment-requirement-types'

const MAX_RANGE_LENGTH = 128
const MAX_COMPARATORS = 4
const MAX_EXTRACT_INPUT = 4096
const COMPARATOR_TOKEN = /^(>=|<=|>|<|=)(\d{1,9})(?:\.(\d{1,9}))?(?:\.(\d{1,9}))?$/
const VERSION_TOKEN = /\d{1,9}\.\d{1,9}(?:\.\d{1,9})?/
const VERSION_EXACT = /^(\d{1,9})(?:\.(\d{1,9}))?(?:\.(\d{1,9}))?$/

type VersionTriple = readonly [number, number, number]

function toTriple(major: string, minor?: string, patch?: string): VersionTriple {
  return [Number(major), Number(minor ?? 0), Number(patch ?? 0)]
}

// Closed grammar: space-separated `>=,>,<=,<,=` comparators over MAJOR[.MINOR[.PATCH]], AND only.
export function parseVersionRange(raw: string): RequirementVersionRange {
  const unsupported: RequirementVersionRange = { status: 'unsupported', raw }
  if (raw.length === 0 || raw.length > MAX_RANGE_LENGTH) {
    return unsupported
  }
  const tokens = raw.trim().split(/\s+/)
  if (tokens.length === 0 || tokens[0] === '' || tokens.length > MAX_COMPARATORS) {
    return unsupported
  }
  const comparators: VersionComparator[] = []
  for (const token of tokens) {
    const match = COMPARATOR_TOKEN.exec(token)
    if (!match) {
      return unsupported
    }
    comparators.push({
      op: match[1] as VersionComparator['op'],
      version: toTriple(match[2], match[3], match[4])
    })
  }
  return { status: 'supported', raw, comparators }
}

// Why: bound the scan so a hostile CLI cannot make the probe chew unbounded output.
export function extractFirstVersion(output: string): string | null {
  const match = VERSION_TOKEN.exec(output.slice(0, MAX_EXTRACT_INPUT))
  return match ? match[0] : null
}

function compareTriples(a: VersionTriple, b: VersionTriple): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1
    }
  }
  return 0
}

export function satisfiesVersionRange(
  version: string,
  comparators: readonly VersionComparator[]
): boolean {
  const match = VERSION_EXACT.exec(version)
  if (!match) {
    return false
  }
  const actual = toTriple(match[1], match[2], match[3])
  return comparators.every(({ op, version: bound }) => {
    const order = compareTriples(actual, bound)
    switch (op) {
      case '>=':
        return order >= 0
      case '>':
        return order > 0
      case '<=':
        return order <= 0
      case '<':
        return order < 0
      case '=':
        return order === 0
    }
  })
}
