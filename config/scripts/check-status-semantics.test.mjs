import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EXIT_GATE_FAILED,
  EXIT_INVALID,
  EXIT_OK,
  contrastRatio,
  extractBlock,
  findPhantomVariableReferences,
  hexToRgb,
  main,
  parseDebtBaseline,
  resolveLiteral,
  parseDeclarations
} from './check-status-semantics.mjs'

// Why the real `main` against a synthetic stylesheet: a drill pinned to a real offender has an
// interest in that offender surviving, and decays the day it is fixed. The fixture below
// represents the class, so these assertions keep working when main.css is perfect — and the
// "green" half is what stops a gate that rejects everything from passing the red half.

const tempDirs = []
const TOKEN_SOURCE = 'src/renderer/src/assets/main.css'

const LIGHT = {
  background: '#ffffff',
  card: '#ffffff',
  muted: '#f5f5f5',
  sidebar: '#fafafa',
  // Not the real #737373: that is 4.35:1 on #f5f5f5 and is genuine frozen debt in this repo.
  // A synthetic subject that inherits a real offender makes the green control fail for a
  // reason that has nothing to do with the clause under test.
  'muted-foreground': '#6b6b6b',
  'status-success': '#15803d',
  'status-warning': '#b45309',
  'status-unknown': '#52525b',
  'status-error': 'var(--color-red-600)',
  ring: '#525252',
  'sidebar-primary': '#171717',
  'sidebar-primary-foreground': '#fafafa'
}

const DARK = {
  background: '#0a0a0a',
  card: '#171717',
  muted: '#262626',
  sidebar: '#171717',
  'muted-foreground': '#a1a1a1',
  'status-success': '#86efac',
  'status-warning': '#fcd34d',
  'status-unknown': '#d4d4d8',
  'status-error': 'var(--color-red-400)',
  // Deliberately not #a1a1a1: that is --muted-foreground in this theme, and the channel
  // clause rejects an interaction token wearing a system token's value. Caught here first.
  ring: '#737373',
  'sidebar-primary': '#1447e6',
  'sidebar-primary-foreground': '#fafafa'
}

const STATES = [
  {
    state: 'HEALTHY',
    token: 'status-success',
    channel: 'system',
    contrast: 'measured',
    contrastRole: 'text'
  },
  {
    state: 'PRESSURED',
    token: 'status-warning',
    channel: 'system',
    contrast: 'measured',
    contrastRole: 'text'
  },
  {
    state: 'CRITICAL',
    token: 'status-error',
    channel: 'system',
    contrast: 'indirect',
    contrastRole: 'text'
  },
  {
    state: 'UNKNOWN',
    token: 'status-unknown',
    channel: 'system',
    contrast: 'measured',
    contrastRole: 'text',
    separated: true
  },
  {
    state: 'IDLE',
    token: 'muted-foreground',
    channel: 'system',
    contrast: 'measured',
    contrastRole: 'text'
  },
  {
    state: 'SELECTED',
    token: 'ring',
    channel: 'interaction',
    contrast: 'measured',
    contrastRole: 'nonText'
  },
  {
    state: 'ACTIVE_PROJECT',
    token: 'sidebar-primary',
    channel: 'interaction',
    contrast: 'measured',
    contrastRole: 'surface',
    pairedForeground: 'sidebar-primary-foreground'
  }
]

const POLICY = {
  tokenSource: TOKEN_SOURCE,
  surfaceTokens: ['background', 'card', 'muted', 'sidebar'],
  themes: ['light', 'dark'],
  contrastFloors: { text: 4.5, nonText: 3, surface: 4.5 },
  separationFrom: 'muted-foreground',
  minimumSeparationContrast: 1.3,
  minimumSeparationRgbDistance: 30,
  debtBaseline: 'config/status-contrast-debt-baseline.txt',
  minimumStates: 1
}

const CHANNELS = {
  interaction: ['ring', 'sidebar-primary', 'accent'],
  system: ['status-success', 'status-warning', 'status-error', 'status-unknown', 'muted-foreground']
}

function declarations(vars) {
  return Object.entries(vars)
    .map(([name, value]) => `  --${name}: ${value};`)
    .join('\n')
}

function buildCss({
  light = LIGHT,
  dark = DARK,
  themeExposed,
  extraRules = '',
  omitRoot = false
} = {}) {
  const exposed = themeExposed ?? Object.keys(LIGHT)
  return [
    '@theme inline {',
    exposed.map((name) => `  --color-${name}: var(--${name});`).join('\n'),
    '}',
    '',
    ...(omitRoot ? [] : [':root {', declarations(light), '}']),
    '',
    '.dark {',
    declarations(dark),
    '}',
    '',
    extraRules
  ].join('\n')
}

function makeRoot({
  css,
  states = STATES,
  policy = POLICY,
  channels = CHANNELS,
  schemaVersion = 1,
  manifestText,
  debt = '',
  omitDebtFile = false,
  consumerFiles = {}
} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-status-semantics-'))
  tempDirs.push(root)
  mkdirSync(path.join(root, 'config'), { recursive: true })
  mkdirSync(path.join(root, path.dirname(TOKEN_SOURCE)), { recursive: true })

  writeFileSync(
    path.join(root, 'config', 'status-semantics.jsonc'),
    manifestText ?? JSON.stringify({ schemaVersion, policy, channels, states }),
    'utf8'
  )
  if (!omitDebtFile) {
    writeFileSync(path.join(root, 'config', 'status-contrast-debt-baseline.txt'), debt, 'utf8')
  }
  writeFileSync(path.join(root, TOKEN_SOURCE), css ?? buildCss(), 'utf8')
  for (const [relative, body] of Object.entries(consumerFiles)) {
    const full = path.join(root, relative)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, body, 'utf8')
  }
  return root
}

function run(options) {
  const out = []
  const errors = []
  return main({
    root: makeRoot(options),
    log: (m) => out.push(String(m)),
    error: (m) => errors.push(String(m))
  }).then((code) => ({ code, out: out.join('\n'), errors: errors.join('\n') }))
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true })
  }
})

describe('colour maths', () => {
  it('computes the WCAG ratio for the canonical extremes', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 2)
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5)
  })

  it('reads three-digit hex, which main.css uses for #fff', () => {
    expect(hexToRgb('#fff')).toEqual([255, 255, 255])
    expect(hexToRgb('nonsense')).toBeNull()
  })

  it('pins the two shipped tokens at the weight they were chosen for', () => {
    // These are the numbers the style guide cites. If a future edit moves either token, this
    // fails here rather than in a screenshot nobody takes.
    expect(contrastRatio('#b45309', '#ffffff')).toBeCloseTo(5.02, 1)
    expect(contrastRatio('#fcd34d', '#0a0a0a')).toBeCloseTo(13.73, 1)
  })
})

describe('token resolution', () => {
  it('separates "absent" from "forwards somewhere this file does not define"', () => {
    const decls = parseDeclarations('  --a: #fff;\n  --b: var(--a);\n  --c: var(--color-red-600);')
    expect(resolveLiteral(decls, 'a')).toEqual({ found: true, literal: '#fff' })
    expect(resolveLiteral(decls, 'b')).toEqual({ found: true, literal: '#fff' })
    expect(resolveLiteral(decls, 'c')).toMatchObject({ found: true, literal: null })
    expect(resolveLiteral(decls, 'missing')).toEqual({ found: false })
  })

  it('reports a missing block as null rather than as an empty one', () => {
    // An empty map would read as "every token is absent", which is a different verdict.
    expect(extractBlock('.dark {\n  --a: #fff;\n}', ':root')).toBeNull()
    expect(extractBlock(':root {\n  --a: #fff;\n}', ':root')).toContain('--a')
  })
})

describe('the happy path', () => {
  it('passes a stylesheet that satisfies every clause', async () => {
    const { code, out, errors } = await run({})
    // Assert the diagnostics first: a bare exit-code mismatch says a clause fired and not which.
    expect(errors).toBe('')
    expect(code).toBe(EXIT_OK)
    expect(out).toContain('7 states')
    expect(out).toContain('2 channels separated')
  })

  it('measured something — a parser that went blind must not read as clean', async () => {
    const { out } = await run({})
    const measured = Number(/(\d+) contrast measurements/.exec(out)?.[1])
    expect(measured).toBeGreaterThan(20)
  })
})

describe('a token must exist and be reachable', () => {
  it('fails when a declared token is absent from one theme', async () => {
    const light = { ...LIGHT }
    delete light['status-warning']
    const { code, errors } = await run({ css: buildCss({ light }) })
    expect(code).toBe(EXIT_INVALID)
    expect(errors).toContain('--status-warning is not declared in the light theme')
  })

  it('fails when a token exists but no Tailwind utility can resolve it', async () => {
    const exposed = Object.keys(LIGHT).filter((n) => n !== 'status-unknown')
    const { code, errors } = await run({ css: buildCss({ themeExposed: exposed }) })
    expect(code).toBe(EXIT_INVALID)
    expect(errors).toContain('is not exposed in the "@theme inline" block')
  })
})

describe('the contrast check cannot be blinded', () => {
  it('fails when a "measured" token is rewritten to forward elsewhere', async () => {
    // The dangerous direction: contrast silently stops being computed and everything is green.
    const light = { ...LIGHT, 'status-warning': 'var(--color-amber-700)' }
    const { code, errors } = await run({ css: buildCss({ light }) })
    expect(code).toBe(EXIT_INVALID)
    expect(errors).toContain('the contrast check cannot see it')
  })

  it('fails when an "indirect" entry has become literal, so the list cannot go stale', async () => {
    const light = { ...LIGHT, 'status-error': '#dc2626' }
    const { code, errors } = await run({ css: buildCss({ light }) })
    expect(code).toBe(EXIT_INVALID)
    expect(errors).toContain('upgrade this entry to "measured"')
  })
})

describe('the floor depends on what the colour is', () => {
  it('fails a text token below 4.5:1', async () => {
    const light = { ...LIGHT, 'status-warning': '#d97706' } // 3.19:1 on #ffffff
    const { code, errors } = await run({ css: buildCss({ light }) })
    expect(code).toBe(EXIT_INVALID)
    expect(errors).toContain('below the 4.5:1 text floor')
  })

  it('passes a non-text token between 3:1 and 4.5:1 — a ring is not body copy', async () => {
    // The control for the clause above. #767676 on #ffffff is ~4.4:1: red as text, fine as a
    // focus indicator. Without this, a gate that simply applied 4.5 everywhere would look
    // identical to one that knows the difference.
    const light = { ...LIGHT, ring: '#767676' }
    const { code } = await run({ css: buildCss({ light }) })
    expect(code).toBe(EXIT_OK)
  })

  it('judges a surface against the foreground painted on it, not against the page', async () => {
    // #1447e6 is 2.90:1 on the dark background and would fail as text; what matters is that
    // --sidebar-primary-foreground is legible ON it.
    const { code } = await run({})
    expect(code).toBe(EXIT_OK)

    const dark = { ...DARK, 'sidebar-primary-foreground': '#1a4fd0' }
    const failed = await run({ css: buildCss({ dark }) })
    expect(failed.code).toBe(EXIT_INVALID)
    expect(failed.errors).toContain('below the 4.5:1 surface floor')
  })
})

describe('UNKNOWN must be separable from disabled, not merely legible', () => {
  it('fails zinc-500, which passes contrast and reads as muted text', async () => {
    // The measured case: #71717a is 8 rgb units from --muted-foreground. Legible, and the
    // same colour to a reader — which turns "we do not know" into "nothing here".
    const light = { ...LIGHT, 'status-unknown': '#71717a' }
    const { code, errors } = await run({ css: buildCss({ light }) })
    expect(code).toBe(EXIT_INVALID)
    expect(errors).toContain('is not separable from --muted-foreground')
    expect(errors).toContain('reads as "disabled"')
  })

  it('passes zinc-600, which is the same hue family and 52 units away', async () => {
    const { code } = await run({})
    expect(code).toBe(EXIT_OK)
  })
})

describe('selection is not health', () => {
  it('fails when an interaction token and a system token share a value', async () => {
    const light = { ...LIGHT, ring: '#15803d' } // the success green, used to point at a row
    const { code, errors } = await run({ css: buildCss({ light }) })
    expect(code).toBe(EXIT_INVALID)
    expect(errors).toContain('must never share a colour')
  })

  it('fails when a state uses a channel it is not listed under', async () => {
    const states = STATES.map((s) => (s.state === 'HEALTHY' ? { ...s, channel: 'interaction' } : s))
    const { code, errors } = await run({ states })
    expect(code).toBe(EXIT_INVALID)
    expect(errors).toContain('is not listed under it')
  })
})

describe('phantom variable references', () => {
  it('finds a var() nothing declares', async () => {
    const { code, errors } = await run({
      css: buildCss({ extraRules: '.x {\n  color: var(--ghost, #f59e0b);\n}' })
    })
    expect(code).toBe(EXIT_INVALID)
    expect(errors).toContain('references var(--ghost) but nothing declares it')
  })

  it('accepts a frozen phantom and the declared runtime families', async () => {
    const policy = {
      ...POLICY,
      externallyDeclaredVariables: ['window-controls-width'],
      externallyDeclaredPrefixes: ['radix-']
    }
    const { code } = await run({
      policy,
      debt: 'PHANTOM|ghost  # frozen for the drill\n',
      css: buildCss({
        extraRules:
          '.x {\n  color: var(--ghost, #f59e0b);\n  right: var(--window-controls-width);\n  height: var(--radix-popover-content-available-height);\n}'
      })
    })
    expect(code).toBe(EXIT_OK)
  })

  it('does not treat the Tailwind palette as phantom', async () => {
    const { code } = await run({
      css: buildCss({ extraRules: '.x {\n  color: var(--color-red-600);\n}' })
    })
    expect(code).toBe(EXIT_OK)
  })
})

describe('the debt baseline is a ratchet, not an exemption list', () => {
  it('accepts a frozen offender', async () => {
    const light = { ...LIGHT, 'status-warning': '#d97706' }
    const debt = [
      'PRESSURED|status-warning|light|background  # frozen',
      'PRESSURED|status-warning|light|card  # frozen',
      'PRESSURED|status-warning|light|muted  # frozen',
      'PRESSURED|status-warning|light|sidebar  # frozen'
    ].join('\n')
    const { code, out } = await run({ css: buildCss({ light }), debt })
    expect(code).toBe(EXIT_OK)
    expect(out).toContain('4 frozen debt(s)')
  })

  it('fails a frozen entry that no longer offends, so the list cannot outlive its debts', async () => {
    const { code, errors } = await run({
      debt: 'PRESSURED|status-warning|light|background  # fixed long ago\n'
    })
    expect(code).toBe(EXIT_INVALID)
    expect(errors).toContain('no longer fails')
  })

  it('refuses an exemption with no reason', async () => {
    const { code, errors } = await run({ debt: 'PRESSURED|status-warning|light|background\n' })
    expect(code).toBe(EXIT_GATE_FAILED)
    expect(errors).toContain('no reason')
  })

  it('parses comments and blank lines without inventing entries', () => {
    const debt = parseDebtBaseline('# header\n\n  A|b|light|c  # why  \n')
    expect(debt.size).toBe(1)
    expect(debt.get('A|b|light|c')).toBe('why')
  })
})

describe('a token-true sheet has to actually resolve its tokens', () => {
  const SHEET = 'docs/visual/sheets/example.html'
  const withConsumer = (body) => ({
    policy: { ...POLICY, tokenConsumers: [SHEET] },
    consumerFiles: { [SHEET]: body }
  })

  it('passes a sheet whose every token exists', async () => {
    const { code, out } = await run(
      withConsumer(
        '<style>.a{color:var(--status-warning);background:var(--status-unknown)}</style>'
      )
    )
    expect(code).toBe(EXIT_OK)
    expect(out).toContain('2 token reference(s)')
  })

  it('fails a typo, which would otherwise render as nothing at all', async () => {
    const { code, errors } = await run(
      withConsumer('<style>.a{color:var(--status-warnng)}</style>')
    )
    expect(code).toBe(EXIT_INVALID)
    expect(errors).toContain('main.css does not declare')
    expect(errors).toContain('render as nothing')
  })

  it('accepts a token the sheet declares itself', async () => {
    const { code } = await run(
      withConsumer(
        '<style>:root{--sheet-gap:8px}.a{gap:var(--sheet-gap);color:var(--status-unknown)}</style>'
      )
    )
    expect(code).toBe(EXIT_OK)
  })

  it('fails a "token-true" sheet that references no tokens', async () => {
    // Otherwise a sheet that was rewritten with hardcoded hexes keeps its label and its green.
    const { code, errors } = await run(withConsumer('<style>.a{color:#b45309}</style>'))
    expect(code).toBe(EXIT_INVALID)
    expect(errors).toContain('references no tokens at all')
  })

  it('reports a consumer it cannot read rather than skipping it', async () => {
    const { code, errors } = await run({ policy: { ...POLICY, tokenConsumers: [SHEET] } })
    expect(code).toBe(EXIT_INVALID)
    expect(errors).toContain('could not be read')
  })
})

describe('floors on the sweep itself', () => {
  it('fails when states are dropped below the declared minimum', async () => {
    const { code, errors } = await run({
      policy: { ...POLICY, minimumStates: 8 },
      states: STATES.slice(0, 2)
    })
    expect(code).toBe(EXIT_INVALID)
    expect(errors).toContain('expected at least 8')
  })
})

describe('a gate that could not judge is not a gate that rejected', () => {
  it('exits 2 on an unparseable manifest', async () => {
    const { code, errors } = await run({ manifestText: '{ not json' })
    expect(code).toBe(EXIT_GATE_FAILED)
    expect(errors).toContain('could not be read or parsed')
  })

  it('exits 2 when the :root block is gone, rather than reporting every token missing', async () => {
    const { code, errors } = await run({ css: buildCss({ omitRoot: true }) })
    expect(code).toBe(EXIT_GATE_FAILED)
    expect(errors).toContain('could not find the ":root" block')
  })

  it('exits 2 when the debt baseline is missing', async () => {
    const { code, errors } = await run({ omitDebtFile: true })
    expect(code).toBe(EXIT_GATE_FAILED)
    expect(errors).toContain('could not read config/status-contrast-debt-baseline.txt')
  })

  it('exits 2 on an unsupported schemaVersion', async () => {
    const { code } = await run({ schemaVersion: 99 })
    expect(code).toBe(EXIT_GATE_FAILED)
  })
})

describe('findPhantomVariableReferences, directly', () => {
  it('reports the first line of each distinct phantom and nothing else', () => {
    const css =
      ':root {\n  --a: #fff;\n}\n.x { color: var(--a); }\n.y { color: var(--b, red); }\n.z { color: var(--b); }'
    const found = findPhantomVariableReferences(css)
    expect(found).toEqual([{ name: 'b', line: 5 }])
  })
})
