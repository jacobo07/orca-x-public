import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

const terminalCss = fs.readFileSync(new URL('./terminal.css', import.meta.url), 'utf8')

describe('terminal container geometry', () => {
  it('keeps the hidden link tooltip out of the fitted terminal height', () => {
    expect(terminalCss).toMatch(
      /\.xterm-container\s*{[^}]*height:\s*calc\(100% - var\(--pane-padding-y, 4px\)\);/s
    )
    expect(terminalCss).toMatch(
      /\.pane\[data-has-title\] \.xterm-container\s*{[^}]*height:\s*calc\(100% - var\(--orca-pane-title-height\)\);/s
    )
    expect(terminalCss).toMatch(
      /\.pane-link-tooltip\s*{[^}]*height:\s*var\(--orca-terminal-link-tooltip-height\);/s
    )
  })

  it('shrinks the fitted terminal by exactly the voice dock it reserves', () => {
    // The dock is persistently visible, so unlike the reveal-on-hover pane
    // controls it cannot float over row content. Reserving without shrinking
    // would leave the PTY believing it still owns the covered row.
    expect(terminalCss).toMatch(
      /\.pane\[data-has-voice-dock\] \.xterm-container\s*{[^}]*height:\s*calc\(100% - var\(--orca-terminal-voice-dock-height\)\);/s
    )
    expect(terminalCss).toMatch(
      /\.terminal-voice-dock\s*{[^}]*height:\s*var\(--orca-terminal-voice-dock-height\);/s
    )
  })

  it('subtracts both reservations from a pane carrying a title and a dock', () => {
    // The two rules are independent and equally specific, so without a combined
    // rule the later one wins outright and the other reserved strip goes back
    // to covering terminal rows.
    expect(terminalCss).toMatch(
      /\.pane\[data-has-title\]\[data-has-voice-dock\] \.xterm-container\s*{[^}]*height:\s*calc\(100% - var\(--orca-pane-title-height\) - var\(--orca-terminal-voice-dock-height\)\);/s
    )
  })
})
