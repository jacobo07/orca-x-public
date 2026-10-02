import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'jsonc-parser'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { STATUS_MARK, STATUS_STATES, StatusMark } from './status-mark'

type ManifestState = { state: string; token: string; channel: string; structuralCue: string }

const manifest = parse(
  readFileSync(join(__dirname, '../../../../../config/status-semantics.jsonc'), 'utf8')
) as { states: ManifestState[] }
const systemStates = manifest.states.filter((s) => s.channel === 'system')

describe('StatusMark', () => {
  it('covers exactly the manifest system states', () => {
    expect(systemStates.length).toBeGreaterThanOrEqual(6)
    expect([...STATUS_STATES].sort()).toEqual(systemStates.map((s) => s.state).sort())
  })

  it.each(systemStates)('$state draws its manifest token and shape', (entry) => {
    const spec = STATUS_MARK[entry.state as keyof typeof STATUS_MARK]
    expect(spec.cssVar).toBe(entry.token)
    expect(spec.className).toContain(entry.token)
    const hollow = entry.structuralCue.startsWith('hollow')
    expect(spec.shape).toBe(hollow ? 'hollow' : 'filled')
    // A hollow mark paints its ring and nothing inside it; a filled one paints the token.
    expect(spec.className.includes('bg-transparent')).toBe(hollow)
    expect(spec.className.includes('border')).toBe(hollow)
  })

  it('UNKNOWN is hollow and IDLE is hollow; neither is drawn like HEALTHY', () => {
    expect(STATUS_MARK.UNKNOWN.shape).toBe('hollow')
    expect(STATUS_MARK.IDLE.shape).toBe('hollow')
    expect(STATUS_MARK.HEALTHY.shape).toBe('filled')
  })

  it('names itself when labelled and hides from assistive tech when a word sits beside it', () => {
    const labelled = renderToStaticMarkup(<StatusMark state="UNKNOWN" label="State unknown" />)
    expect(labelled).toContain('role="img"')
    expect(labelled).toContain('aria-label="State unknown"')
    expect(labelled).toContain('data-status-shape="hollow"')
    const bare = renderToStaticMarkup(<StatusMark state="HEALTHY" />)
    expect(bare).toContain('aria-hidden="true"')
    expect(bare).not.toContain('role=')
  })
})
