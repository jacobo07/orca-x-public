import { readFile } from 'node:fs/promises'
import type { ProjectMdRecord } from '../../shared/mission-brief-types'
import { markdownSection } from './state-md-record'

/**
 * The goal `.planning/PROJECT.md` states, quoted. GSD's planning inspect names only the milestone,
 * so without this a project whose goal is written down reads as if it had none.
 */

const INLINE_CORE_VALUE = /^\s*\*\*Core value:?\*\*:?\s*(.+)$/i
const HEADING = /^#{1,6}\s/

/** Lines of the first paragraph, joined; blank lines before it are skipped. */
function firstParagraph(lines: string[] | null): string | null {
  if (!lines) {
    return null
  }
  const out: string[] = []
  for (const line of lines) {
    if (line.trim().length === 0) {
      if (out.length > 0) {
        break
      }
      continue
    }
    if (HEADING.test(line)) {
      break
    }
    out.push(line.trim())
  }
  return out.length > 0 ? out.join(' ') : null
}

export function parseProjectMdRecord(text: string): ProjectMdRecord {
  const lines = text.split(/\r?\n/)
  const inline = lines.map((line) => INLINE_CORE_VALUE.exec(line)?.[1]?.trim()).find(Boolean)
  return {
    whatThisIs: firstParagraph(markdownSection(lines, /^what this is$/i)),
    coreValue: inline ?? firstParagraph(markdownSection(lines, /^core value$/i))
  }
}

/** `null` when the file is absent or unreadable; the brief then falls back to the milestone. */
export async function readProjectMdRecord(projectPath: string): Promise<ProjectMdRecord | null> {
  try {
    return parseProjectMdRecord(await readFile(projectPath, 'utf8'))
  } catch {
    return null
  }
}
