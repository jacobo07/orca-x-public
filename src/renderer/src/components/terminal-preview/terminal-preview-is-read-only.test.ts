import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The hover preview observes a terminal. It must never acquire the authorities the interactive
 * preview holds.
 *
 * terminalPreview.fit resizes the PTY through the remote-desktop viewer registry and parks the host
 * pane; terminalPreview.input writes to the child; focus() takes the caret. Each is correct for the
 * dashboard dialog, which asked for them, and catastrophic for a card that opens because a pointer
 * passed over a row.
 *
 * A source sweep rather than a behavioural test on purpose: the failure it guards is someone later
 * reaching for the convenient call, and that is visible in the source before it is visible at
 * runtime. Comments are stripped before matching — the first version of this test failed on its own
 * documentation, which is the cheapest possible reminder that a text matcher matches prose too.
 *
 * Every pattern carries a control pointing at the module that legitimately uses it. That is not
 * ceremony: the first control here named the wrong file, and without it the fit assertion would have
 * been reported as a clean pass by a matcher aimed at a file that never contained the call.
 */

const OBSERVER_DIR = import.meta.dirname
const POPOUT_DIR = path.resolve(OBSERVER_DIR, '../dashboard-popout')

/** Each is an authority over the observed terminal, not a way of looking at it. */
const FORBIDDEN_IN_OBSERVER = [
  {
    pattern: 'terminalPreview.fit',
    why: 'resizes the PTY and parks the host pane',
    control: 'preview-grid-claim.ts'
  },
  {
    pattern: 'terminalPreview.input',
    why: 'writes to the child process',
    control: 'AgentTerminalPreview.tsx'
  },
  {
    pattern: '.focus()',
    why: 'takes the caret away from whatever the user was using',
    control: 'AgentTerminalPreview.tsx'
  }
]

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function observerSources(): { name: string; code: string }[] {
  return readdirSync(OBSERVER_DIR)
    .filter((name) => /\.tsx?$/.test(name) && !name.endsWith('.test.ts'))
    .map((name) => ({
      name,
      code: withoutComments(readFileSync(path.join(OBSERVER_DIR, name), 'utf8'))
    }))
}

describe('the terminal preview observer surface', () => {
  it('sweeps a non-empty set of observer modules', () => {
    // Without this the suite would pass just as cleanly if the directory were renamed away.
    const names = observerSources().map((file) => file.name)
    expect(names.length).toBeGreaterThanOrEqual(3)
    expect(names).toContain('TerminalPreviewCard.tsx')
    expect(names).toContain('use-terminal-preview-terminal.ts')
  })

  it.each(FORBIDDEN_IN_OBSERVER)('never calls $pattern — it $why', ({ pattern }) => {
    const offenders = observerSources()
      .filter((file) => file.code.includes(pattern))
      .map((file) => file.name)
    expect(offenders).toEqual([])
  })

  it.each(FORBIDDEN_IN_OBSERVER)(
    'positive control: $control still proves the $pattern matcher works',
    ({ pattern, control }) => {
      // The interactive preview legitimately does all three. If a control stops matching, the
      // assertion above has become a check that cannot fail, and would report the same clean green
      // whether or not the observer had grown an authority.
      const code = withoutComments(readFileSync(path.join(POPOUT_DIR, control), 'utf8'))
      expect(code).toContain(pattern)
    }
  )

  it('keeps xterm structurally unable to take input in the observer', () => {
    const hook = observerSources().find((file) => file.name === 'use-terminal-preview-terminal.ts')
    // A promise not to route input is weaker than a terminal that cannot accept it.
    expect(hook?.code).toContain('disableStdin: true')
  })
})
