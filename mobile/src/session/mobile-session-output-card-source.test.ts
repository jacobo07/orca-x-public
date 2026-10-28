import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const route = readFileSync(
  new URL('../../app/h/[hostId]/session/[worktreeId].tsx', import.meta.url),
  'utf8'
)
const styles = readFileSync(new URL('./mobile-session-frame-styles.ts', import.meta.url), 'utf8')

describe('terminal output card', () => {
  it('wraps the terminal frame, which keeps the fit measurement', () => {
    const card = route.indexOf('<View style={styles.terminalCard}>')
    const frame = route.indexOf('style={styles.terminalFrame}')
    expect(card).toBeGreaterThan(-1)
    expect(frame).toBeGreaterThan(card)
    // Why: onLayout feeds measureFitDimensions; on the card it would count the border as terminal height.
    const between = route.slice(card, frame)
    expect(between).not.toContain('onLayout')
    expect(route.slice(frame, frame + 200)).toContain('onLayout')
    expect(route.match(/styles\.terminalCard/g)).toHaveLength(1)
  })

  it('leaves the pending-tab state outside the card', () => {
    const pending = route.indexOf('activePendingTerminalTab ? (')
    const card = route.indexOf('<View style={styles.terminalCard}>')
    expect(pending).toBeGreaterThan(-1)
    expect(card).toBeGreaterThan(pending)
    expect(route.slice(pending, card)).toContain("'Loading terminal'")
  })

  it('takes the card geometry from theme tokens', () => {
    const block = styles.slice(styles.indexOf('terminalCard: {'))
    const body = block.slice(0, block.indexOf('}'))
    expect(body).toContain('marginHorizontal: spacing.sm')
    expect(body).toContain('borderRadius: radii.card')
    expect(body).toContain('borderColor: colors.borderSubtle')
    expect(body).toContain('backgroundColor: colors.terminalBg')
    expect(body).toContain("overflow: 'hidden'")
  })
})
