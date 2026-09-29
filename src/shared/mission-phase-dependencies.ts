/**
 * GSD phase ids and `depends_on` text. The two GSD readers spell one phase two ways ("01" and "1"),
 * and `depends_on` is prose ("Phase 1, 2", "Phases 2-7", "Phase 5 and the provider pane shipping the
 * contract"), so this keeps the phase references and reports any leftover words as an external
 * condition instead of dropping them.
 */

const PHASE_ID = /^\d+(?:\.\d+)*$/
const PHASE_LIST = /\bPhases?\s+(\d+(?:\.\d+)*(?:\s*(?:[-–]|,|\band\b|&)\s*\d+(?:\.\d+)*)*)/gi
const RANGE = /^(\d+)\s*[-–]\s*(\d+)$/
// Why a bound: a typo such as "Phase 1-9999" must not expand into thousands of ids.
const MAX_RANGE = 64

export function normalizePhaseId(raw: string): string | null {
  const trimmed = raw.trim()
  if (!PHASE_ID.test(trimmed)) {
    return null
  }
  return trimmed
    .split('.')
    .map((part) => String(Number.parseInt(part, 10)))
    .join('.')
}

function expandList(list: string): string[] {
  const ids: string[] = []
  const withRanges = list.replace(/\s*[-–]\s*/g, '-')
  for (const part of withRanges.split(/\s*(?:,|\band\b|&)\s*/i)) {
    const range = RANGE.exec(part)
    if (range) {
      const from = Number.parseInt(range[1], 10)
      const to = Number.parseInt(range[2], 10)
      if (to >= from && to - from <= MAX_RANGE) {
        for (let n = from; n <= to; n++) {
          ids.push(String(n))
        }
      }
      continue
    }
    const id = normalizePhaseId(part)
    if (id) {
      ids.push(id)
    }
  }
  return ids
}

export type ParsedDependencies = { ids: string[]; external: string | null }

export function parseDependsOn(text: string | null | undefined): ParsedDependencies {
  if (!text || /^\s*(nothing|none)\b/i.test(text)) {
    return { ids: [], external: null }
  }
  const ids: string[] = []
  const remainder = text.replace(PHASE_LIST, (_match, list: string) => {
    ids.push(...expandList(list))
    return ' '
  })
  const external = remainder
    .replace(/^[\s,;&]*(?:\band\b|\bplus\b)?[\s,;&]*/i, '')
    .replace(/[\s,;&]+$/, '')
    .trim()
  return {
    ids: [...new Set(ids)],
    external: /[a-z]/i.test(external) ? external : null
  }
}
