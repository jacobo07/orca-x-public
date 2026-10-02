// A system-status DOT (the six STYLEGUIDE states) is drawn by StatusMark, nowhere else. A surface that
// paints one of those tokens as a dot fill or hollow ring by hand fails here. Tinted pills
// (`-background`, `-border`, `/10`) are a different primitive and are not matched.

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const RENDERER = join(__dirname, '../..')
const OWNER = 'components/ui/status-mark.tsx'

const DOT =
  /\b(?:bg-\[var\(--(?:status-(?:success|warning|error|unknown)|agent-question)\)\]|border-\[var\(--status-unknown\)\]|bg-status-(?:success|warning|error|unknown)(?![\w/-])|border-status-unknown(?![\w/-])|bg-agent-question(?![\w/-]))/g

// Exact counts: growth fails, and so does a stale entry whose file no longer draws the dots.
const EXCEPTIONS: Record<string, { count: number; reason: string }> = {
  'components/conversations/AgentChatHeader.tsx': {
    count: 1,
    reason:
      'Different family: where the next turn may run (an admission verdict from the turn runner), not observed system health. Not StatusMark.'
  },
  'components/integration-status-pill.tsx': {
    count: 3,
    reason:
      'Debt: its `neutral` tone is a filled muted dot and nobody has traced what it means; migrate once it is classified (IDLE would be hollow).'
  },
  'components/automations/AutomationListLastRunCell.tsx': {
    count: 2,
    reason:
      'Debt: a run that neither failed nor succeeded is a filled muted dot; classify the non-terminal tones before migrating.'
  }
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      return sources(path)
    }
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

const counts = new Map(
  sources(RENDERER)
    .map(
      (path) =>
        [
          relative(RENDERER, path).split(sep).join('/'),
          (readFileSync(path, 'utf8').match(DOT) ?? []).length
        ] as const
    )
    .filter(([, n]) => n > 0)
)

describe('system-status dots are drawn by StatusMark', () => {
  it('the sweep can see a dot (positive control on the owner and on literal shapes)', () => {
    expect(counts.get(OWNER) ?? 0).toBeGreaterThanOrEqual(5)
    expect("'size-2 rounded-full bg-[var(--status-warning)]'".match(DOT)).toHaveLength(1)
    expect("'bg-status-error'".match(DOT)).toHaveLength(1)
    expect("'border border-status-unknown bg-transparent'".match(DOT)).toHaveLength(1)
    expect(
      "'bg-status-error-background border-status-unknown-border bg-agent-question/10'".match(DOT)
    ).toBeNull()
  })

  it('no surface outside StatusMark hand-draws one, except the named exceptions', () => {
    const offenders = [...counts.keys()].filter((path) => path !== OWNER && !(path in EXCEPTIONS))
    expect(offenders).toEqual([])
  })

  it.each(Object.entries(EXCEPTIONS))(
    '%s keeps exactly its counted dots, for a reason',
    (path, entry) => {
      expect(entry.reason.length).toBeGreaterThan(40)
      expect(counts.get(path) ?? 0).toBe(entry.count)
    }
  )
})
