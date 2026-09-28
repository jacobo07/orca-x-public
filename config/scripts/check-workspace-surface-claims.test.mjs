import { describe, expect, it } from 'vitest'

import {
  MIN_CLAIM_SITES,
  MIN_TONE_MAPS,
  evaluateSurfaceClaims,
  main
} from './check-workspace-surface-claims.mjs'

// Synthetic subjects, never the real surface: a drill pinned to a real file decays the moment that
// file changes. Every red case has a green twin, so a checker that refused everything would fail.

const PRESENTER = 'src/surface/tone-presentation.ts'
const PRODUCER = 'src/shared/agent-projection.ts'
const SURFACE = 'src/surface/Rail.tsx'

const presenterSource = `export type RowTone = 'ready' | 'refused'\n`
const producerSource = `export function projectAgents() { return [] }\n`

function row(testId) {
  return `<ContextRow term={translate('t.${testId}', 'T')} testId="${testId}">x</ContextRow>`
}

function surfaceSource({ extraRows = '', toneMap = true, extraJsx = '' } = {}) {
  const rows = Array.from({ length: MIN_CLAIM_SITES }, (_, i) => row(`claim-${i}`)).join('\n')
  const maps = toneMap
    ? Array.from(
        { length: MIN_TONE_MAPS },
        (_, i) => `const TONE_${i}: Record<RowTone, string> = {
  ready: 'text-[var(--status-success)]',
  refused: 'text-destructive'
}`
      ).join('\n')
    : ''
  return `import type { RowTone } from './tone-presentation'
import { projectAgents } from '../shared/agent-projection'
${maps}
export function Rail() {
  const unknown = translate('state.unknown', 'Unknown')
  return (<>
${rows}
${extraRows}
${extraJsx}
</>)
}
`
}

function config(overrides = {}) {
  const claims = {}
  for (let i = 0; i < MIN_CLAIM_SITES; i++) {
    claims[`claim-${i}`] = {
      producer: `${PRODUCER}#projectAgents`,
      absent: 'state.unknown',
      why: 'derived from the durable roster record'
    }
  }
  return {
    surfaces: ['src/surface'],
    presenters: [{ module: PRESENTER, toneType: 'RowTone' }],
    claims: { ...claims, ...overrides }
  }
}

function judge(source, cfg = config()) {
  const repo = new Map([
    [PRESENTER, presenterSource],
    [PRODUCER, producerSource],
    [SURFACE, source]
  ])
  return evaluateSurfaceClaims({
    config: cfg,
    files: new Map([[SURFACE, source]]),
    read: (p) => repo.get(p) ?? null
  })
}

describe('workspace surface claims gate', () => {
  it('passes a surface whose every claim and colour has a producer (green control)', () => {
    const result = judge(surfaceSource())
    expect(result.failures).toEqual([])
    expect(result.siteCount).toBe(MIN_CLAIM_SITES)
    expect(result.toneMapCount).toBe(MIN_TONE_MAPS)
  })

  it('refuses a new claim row nobody classified (a future "Uptime" row)', () => {
    const result = judge(surfaceSource({ extraRows: row('agent-context-uptime') }))
    expect(result.failures.join('\n')).toMatch(/claim "agent-context-uptime" is not classified/)
  })

  it('accepts that row once it names a producer and an unknown state', () => {
    const result = judge(
      surfaceSource({ extraRows: row('agent-context-uptime') }),
      config({
        'agent-context-uptime': {
          producer: `${PRODUCER}#projectAgents`,
          absent: 'state.unknown',
          why: 'measured by the host that owns the process'
        }
      })
    )
    expect(result.failures).toEqual([])
  })

  it('treats an inline ClaimValue as a claim: unclassified refused, classified accepted', () => {
    const inline = `<ClaimValue testId="desk-session-count">{count}</ClaimValue>`
    expect(judge(surfaceSource({ extraRows: inline })).failures.join('\n')).toMatch(
      /claim "desk-session-count" is not classified/
    )
    const classified = judge(
      surfaceSource({ extraRows: inline }),
      config({
        'desk-session-count': {
          producer: `${PRODUCER}#projectAgents`,
          absent: 'state.unknown',
          why: 'counted from the recorded desk, not estimated'
        }
      })
    )
    expect(classified.failures).toEqual([])
    expect(classified.siteCount).toBe(MIN_CLAIM_SITES + 1)
  })

  it('refuses an inline ClaimValue with no literal identity', () => {
    const result = judge(surfaceSource({ extraRows: `<ClaimValue testId={id}>3</ClaimValue>` }))
    expect(result.failures.join('\n')).toMatch(/ClaimValue has no literal testId/)
  })

  it('refuses a claim row with no literal identity', () => {
    const result = judge(
      surfaceSource({ extraRows: `<ContextRow term="Memory" testId={dynamicId}>1 GB</ContextRow>` })
    )
    expect(result.failures.join('\n')).toMatch(/has no literal testId/)
  })

  it('refuses a hard-coded online dot: a status colour outside any tone map', () => {
    const result = judge(
      surfaceSource({
        extraJsx: `<span className="size-1.5 rounded-full bg-[var(--status-success)]" aria-label="Online" />`
      })
    )
    expect(result.failures.join('\n')).toMatch(/status colour .* outside a presenter tone map/)
  })

  it('refuses a palette green written straight into a class', () => {
    const result = judge(surfaceSource({ extraJsx: `<span className="bg-emerald-500" />` }))
    expect(result.failures.join('\n')).toMatch(/bg-emerald-500/)
  })

  it('refuses a tone map keyed by a local type instead of a presenter tone', () => {
    const local = surfaceSource().replace(
      'export function Rail',
      `type Mine = 'on' | 'off'
const LIVE: Record<Mine, string> = { on: 'bg-[var(--status-success)]', off: 'bg-muted' }
export function Rail`
    )
    const result = judge(local)
    expect(result.failures.join('\n')).toMatch(/outside a presenter tone map/)
  })

  it('refuses a hard-coded model or host name', () => {
    for (const literal of ['claude-opus-4-5', 'gpt-5.2', 'qwen2.5-coder', 'GEX44']) {
      const result = judge(surfaceSource({ extraJsx: `<span>{'${literal}'}</span>` }))
      expect(result.failures.join('\n'), literal).toMatch(/names a model or host/)
    }
  })

  it('does not mistake ordinary copy for a model name (control)', () => {
    const result = judge(
      surfaceSource({
        extraJsx: `<span>{translate('m', 'Chosen by the provider; not recorded')}</span>`
      })
    )
    expect(result.failures).toEqual([])
  })

  it('refuses a classification whose row no surface renders any more (stale)', () => {
    const result = judge(
      surfaceSource(),
      config({
        'agent-context-memory': {
          producer: `${PRODUCER}#projectAgents`,
          absent: 'state.unknown',
          why: 'a row that was deleted from the screen'
        }
      })
    )
    expect(result.failures.join('\n')).toMatch(
      /"agent-context-memory" is classified but no surface/
    )
  })

  it('refuses a producer that does not exist, or is not exported, or never reaches the surface', () => {
    const missing = judge(
      surfaceSource(),
      config({
        'claim-0': {
          producer: 'src/shared/nowhere.ts#x',
          absent: 'state.unknown',
          why: 'a producer that was never written'
        }
      })
    )
    expect(missing.failures.join('\n')).toMatch(/does not exist/)

    const unexported = judge(
      surfaceSource(),
      config({
        'claim-0': {
          producer: `${PRODUCER}#privateHelper`,
          absent: 'state.unknown',
          why: 'names a symbol the module does not export'
        }
      })
    )
    expect(unexported.failures.join('\n')).toMatch(/does not export privateHelper/)

    const unreached = judge(
      surfaceSource().replace("import { projectAgents } from '../shared/agent-projection'\n", ''),
      config()
    )
    expect(unreached.failures.join('\n')).toMatch(/not imported by any surface file/)
  })

  it('refuses a claim whose consumer never renders the unknown state it declares', () => {
    const result = judge(
      surfaceSource(),
      config({
        'claim-0': {
          producer: `${PRODUCER}#projectAgents`,
          absent: 'state.never-drawn',
          why: 'declares an unknown the screen never shows'
        }
      })
    )
    expect(result.failures.join('\n')).toMatch(/never renders its unknown state/)
  })

  it('refuses a declared-unknown row that hides instead of saying so', () => {
    const result = judge(
      surfaceSource(),
      config({
        'claim-0': { producer: null, absent: 'omitted', why: 'no producer and nothing on screen' }
      })
    )
    expect(result.failures.join('\n')).toMatch(/must state its unknown/)
  })

  // One test per floor, each asserting its own number: a single "expected at least" assertion let a
  // mutant that disabled the claim-site floor pass on the tone-map floor's message (drill G5).
  it('refuses when the sweep sees too few claim sites (claim-site floor)', () => {
    const fewRows = surfaceSource().replace(/<ContextRow[^\n]*claim-[1-9][^\n]*\n/g, '')
    const only = config()
    for (let i = 1; i < MIN_CLAIM_SITES; i++) {
      delete only.claims[`claim-${i}`]
    }
    const result = judge(fewRows, only)
    expect(result.failures).toEqual([
      `found 1 claim sites, expected at least ${MIN_CLAIM_SITES}; the sweep may have stopped seeing the surface`
    ])
  })

  it('refuses when the sweep sees too few presenter tone maps (tone-map floor)', () => {
    const result = judge(surfaceSource({ toneMap: false }))
    expect(result.failures).toEqual([
      `found 0 presenter tone maps, expected at least ${MIN_TONE_MAPS}; the sweep may have stopped seeing them`
    ])
  })
})

describe('the real Workspace surface', () => {
  it('is clean and above the floors (positive control on the live estate)', async () => {
    const logs = []
    const original = console.log
    console.log = (line) => logs.push(line)
    try {
      expect(await main(process.cwd())).toBe(0)
    } finally {
      console.log = original
    }
    expect(logs.join('\n')).toMatch(/claim sites classified/)
  })
})
