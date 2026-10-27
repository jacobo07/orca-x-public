import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

const mainCss = fs.readFileSync(new URL('./main.css', import.meta.url), 'utf8')

function ruleBody(selector: string): string {
  const start = mainCss.indexOf(`${selector} {`)
  expect(start, `${selector} rule`).toBeGreaterThanOrEqual(0)
  return mainCss.slice(start, mainCss.indexOf('}', start))
}

// Platform-drawn controls read color-scheme, not the tokens. A dark window without it rendered the
// New agent project select as a light popup whose option text inherited the near-white foreground.
describe('theme roots declare the color-scheme native controls are drawn in', () => {
  it('declares light on the root and dark on the dark theme', () => {
    expect(ruleBody(':root')).toMatch(/color-scheme:\s*light;/)
    expect(ruleBody('.dark')).toMatch(/color-scheme:\s*dark;/)
  })

  it('does not pin popover scrollers to dark in the light theme', () => {
    expect(ruleBody('.popover-scroll-content')).not.toMatch(/color-scheme/)
  })
})
