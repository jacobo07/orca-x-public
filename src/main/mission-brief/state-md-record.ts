import { readFile } from 'node:fs/promises'
import type { StateMdRecord } from '../../shared/mission-brief-types'

/**
 * What `.planning/STATE.md` records, quoted rather than interpreted. GSD's own snapshot returns
 * `null` for a `### Blockers/Concerns` subsection, so the brief quotes the section itself instead of
 * reading GSD's empty answer as "no blockers".
 */

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/
const HEADING = /^(#{1,6})\s+(.*)$/

function frontmatterField(text: string, field: string): string | null {
  const body = FRONTMATTER.exec(text)?.[1]
  if (!body) {
    return null
  }
  const line = body.split(/\r?\n/).find((candidate) => candidate.startsWith(`${field}:`))
  const value = line
    ?.slice(field.length + 1)
    .trim()
    .replace(/^["']|["']$/g, '')
  return value ? value : null
}

/** Lines under the first heading matching `title`, up to the next heading of the same or higher level. */
export function markdownSection(lines: string[], title: RegExp): string[] | null {
  const start = lines.findIndex((line) => {
    const heading = HEADING.exec(line)
    return heading !== null && title.test(heading[2])
  })
  if (start === -1) {
    return null
  }
  const level = HEADING.exec(lines[start])![1].length
  const out: string[] = []
  for (const line of lines.slice(start + 1)) {
    const heading = HEADING.exec(line)
    if (heading && heading[1].length <= level) {
      break
    }
    out.push(line)
  }
  return out
}

function bulletText(line: string): string {
  return line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '').trim()
}

export function parseStateMdRecord(text: string): StateMdRecord {
  const lines = text.split(/\r?\n/)
  const position = markdownSection(lines, /^current position$/i)
  const phaseLine = position?.find((line) => /^\s*Phase:\s*/i.test(line))
  const blockers = markdownSection(lines, /^blockers\b/i)
  return {
    recordedHead: frontmatterField(text, 'state_head'),
    positionPhase: phaseLine ? (/Phase:\s*([\d.]+)/i.exec(phaseLine)?.[1] ?? null) : null,
    blockers: blockers
      ? blockers
          .map(bulletText)
          .filter((line) => line.length > 0 && !HEADING.test(line) && !/^none\.?$/i.test(line))
      : null,
    ownerDecisions: lines.filter((line) => /OWNER DECISION NEEDED/.test(line)).map(bulletText)
  }
}

/** `null` when the file is absent or unreadable; the brief reports blockers and freshness unknown. */
export async function readStateMdRecord(statePath: string): Promise<StateMdRecord | null> {
  try {
    return parseStateMdRecord(await readFile(statePath, 'utf8'))
  } catch {
    return null
  }
}
