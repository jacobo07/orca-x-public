import { describe, expect, it } from 'vitest'

import {
  PRESENTER_MODULE,
  countMintSites,
  evaluateBubbles,
  parseBaseline,
  relativeImports,
  selfCheck
} from './check-mobile-remote-effect-bubbles.mjs'

// Synthetic subjects so the drill does not decay when a real surface moves.
const PRESENTER = {
  [PRESENTER_MODULE]: 'export type MobileNativeChatPendingDelivery = 1\n'
}
const kinds = (result) => result.failures.map((f) => f.kind)

function run(files, baseline = [], minMintSites = 1) {
  return evaluateBubbles({
    files: { ...PRESENTER, ...files },
    baseline: new Set(baseline),
    minMintSites
  })
}

describe('check-mobile-remote-effect-bubbles', () => {
  it('passes its own positive control', () => {
    expect(selfCheck()).toEqual([])
  })

  it('counts every stand-in id prefix it guards, and nothing else', () => {
    expect(countMintSites('`pending-${a}` `local-${b}` `optimistic-${c}` `echo-${d}`')).toBe(4)
    expect(countMintSites("'pending-tab' `session-${a}` `pending-key`")).toBe(0)
  })

  it('refuses a surface that mints a stand-in row without the presenter', () => {
    const result = run({
      'mobile/src/x/Rogue.tsx': 'const row = { id: `pending-${n}`, text }\n'
    })
    expect(kinds(result)).toEqual(['unevidenced-bubble'])
  })

  it('accepts a direct presenter import', () => {
    const result = run({
      'mobile/src/session/direct.ts':
        "import type { MobileNativeChatPendingDelivery } from './mobile-native-chat-delivery-evidence'\nconst id = `pending-${n}`\n"
    })
    expect(result.failures).toEqual([])
    expect(result.evidenced).toEqual(['mobile/src/session/direct.ts'])
  })

  it('accepts one relative hop but not two', () => {
    const files = {
      'mobile/src/session/hop1.ts': "export * from './mobile-native-chat-delivery-evidence'\n",
      'mobile/src/session/hop2.ts': "import './hop1'\n",
      'mobile/src/session/one.ts': "import { a } from './hop1'\nconst id = `pending-${n}`\n",
      'mobile/src/session/two.ts': "import { a } from './hop2'\nconst id = `pending-${n}`\n"
    }
    const result = run(files)
    expect(result.evidenced).toEqual(['mobile/src/session/one.ts'])
    expect(result.failures.map((f) => f.detail.split(' ')[0])).toEqual([
      'mobile/src/session/two.ts'
    ])
  })

  it('lets a receipt-backed surface pass only while it is in the baseline', () => {
    const files = {
      'mobile/app/tasks.tsx': 'const c = result.comment ?? { id: `local-${t}` }\n'
    }
    expect(run(files, ['mobile/app/tasks.tsx']).failures).toEqual([])
    expect(kinds(run(files))).toEqual(['unevidenced-bubble'])
  })

  it('fails a stale baseline line: gone, or now on the presenter', () => {
    expect(kinds(run({}, ['mobile/app/gone.tsx'], 0))).toEqual(['stale-baseline'])
    const files = {
      'mobile/src/session/now.ts':
        "import './mobile-native-chat-delivery-evidence'\nconst id = `pending-${n}`\n"
    }
    expect(kinds(run(files, ['mobile/src/session/now.ts']))).toEqual(['stale-baseline'])
  })

  it('fails when the sweep sees fewer sites than the floor', () => {
    expect(kinds(run({}, [], 5))).toEqual(['population-floor'])
  })

  it('fails when the presenter itself is gone', () => {
    const result = evaluateBubbles({
      files: {},
      baseline: new Set(),
      minMintSites: 0
    })
    expect(kinds(result)).toEqual(['presenter-missing'])
  })

  it('reads relative imports and ignores packages', () => {
    expect(relativeImports("import a from 'react'\nimport b from '../b'\nimport './c'\n")).toEqual([
      '../b',
      './c'
    ])
  })

  it('parses the baseline ignoring comments and blanks', () => {
    expect([...parseBaseline('# note\n\nmobile/a.tsx\n  mobile/b.ts \n')]).toEqual([
      'mobile/a.tsx',
      'mobile/b.ts'
    ])
  })
})
