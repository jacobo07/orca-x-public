import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MIN_LABELS,
  MIN_RPC_METHODS,
  evaluateHostCardClaims,
  labelTable,
  main
} from './check-host-card-claims.mjs'
import { jsxElements } from './host-card-effect-claims.mjs'

// Synthetic card and presenter, except the real-repo rows: every red case has a green twin.

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const CARD = 'app/HostCard.tsx'
const PRESENTER = 'app/host-presentation.ts'
const MODEL = 'shared/model.ts'
const WAKE_RPC = 'host.wake.request'
const SUCCESS_SHAPE =
  /^check-host-card-claims: \d+ labels classified, \d+ controls classified, \d+ host RPC methods known, no unevidenced power-loss state, no control without an effect, \d+ capability producers classified, \d+ capability emitters scanned\.$/

const VOCAB = {
  HOST_EVIDENCE_KINDS: ['live-response'],
  HOST_POWER_STATES: Array.from({ length: MIN_LABELS }, (_, i) => `awake-${i}`),
  HOST_ORCA_STATES: ['unknown'],
  HOST_CAPABILITY_IDS: ['can-wake-lan'],
  HOST_CAPABILITY_VALUES: ['unknown']
}

function presenterSource() {
  const rows = Array.from({ length: MIN_LABELS }, (_, i) => `  'power.awake-${i}': 'Awake',`)
  return `import { compose } from '../shared/model'
export const HOST_CARD_LABELS = {
${rows.join('\n')}
} as const
export function presentHostCardAvailability() { return compose() }
`
}

const WAKE_SIBLING = `<Pressable testID="host-card-wake" onPress={props.onWake} />`

function cardSource({
  openBody = '',
  wake = WAKE_SIBLING,
  after = '',
  imports = '',
  actionsAttrs = ''
} = {}) {
  return `import { presentHostCardAvailability } from './host-presentation'; ${imports}
export function HostCard(props) {
  return (<View>
<Pressable testID="host-card-open" onPress={props.onPress}>
  ${openBody}
</Pressable>
<Pressable testID="host-card-actions" ${actionsAttrs} onPress={props.onOpenActions} />
${wake}
${after}
</View>)
}
`
}

function wakeActions(rpc = WAKE_RPC) {
  return {
    'host-card-open': { kind: 'navigation', why: 'opens the host screen on the phone' },
    'host-card-actions': { kind: 'navigation', why: 'opens the phone-local actions sheet' },
    'host-card-wake': { kind: 'effect', rpc, why: 'sends a wake request to the bound broker' }
  }
}

function evaluate({ card = cardSource(), actions = wakeActions(), extraRpc = [WAKE_RPC] } = {}) {
  const presenter = presenterSource()
  const labels = {}
  for (const row of labelTable(presenter)) {
    labels[row.key] = {
      producer: `${MODEL}#compose`,
      evidence: ['live-response'],
      why: 'the composer proves this from the live answer'
    }
  }
  const files = new Map([
    [CARD, card],
    [PRESENTER, presenter]
  ])
  const repo = { [MODEL]: 'export function compose() {}\n' }
  const rpcMethods = new Set([
    ...Array.from({ length: MIN_RPC_METHODS }, (_, i) => `m.${i}`),
    ...extraRpc
  ])
  return evaluateHostCardClaims({
    config: { card: CARD, presenter: PRESENTER, model: MODEL, labels, actions },
    files,
    read: (p) => files.get(p) ?? repo[p] ?? null,
    rpcMethods,
    vocab: VOCAB
  })
}

function scopeFailures(result) {
  return result.failures.filter((failure) => /effect wording|effect control/.test(failure))
}

async function runMain(configText) {
  const logged = []
  const errors = []
  vi.spyOn(console, 'log').mockImplementation((line) => logged.push(line))
  vi.spyOn(console, 'error').mockImplementation((line) => errors.push(line))
  const code = await main(REPO_ROOT, configText)
  return { code, logged, errors }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('host-card-effect-claims: per-control effect wording (G5 scope)', () => {
  it('fails Wake inside host-card-open while host-card-wake is a backed sibling (the D-09 weakening)', () => {
    const red = evaluate({ card: cardSource({ openBody: '<Text>Wake</Text>' }) })
    expect(scopeFailures(red)).toEqual([
      `${CARD}:5 effect wording "Wake" but no effect control classified to a host RPC method encloses it`
    ])
  })

  it('passes the same Wake inside the host-card-wake Pressable', () => {
    const wake = `<Pressable testID="host-card-wake" onPress={props.onWake}><Text>Wake</Text></Pressable>`
    expect(evaluate({ card: cardSource({ wake }) }).failures).toEqual([])
  })

  it('passes the real repo with the unchanged success-line shape', async () => {
    const { code, logged, errors } = await runMain()
    expect(errors).toEqual([])
    expect(code).toBe(0)
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatch(SUCCESS_SHAPE)
  })
})

const WORDING = (text) =>
  new RegExp(
    `effect wording "${text.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&')}" but no effect control .* encloses it`
  )

describe('host-card-effect-claims: scope rule table', () => {
  it('nesting: an effect control inside host-card-open fails even with legitimate text', () => {
    const openBody = `<Pressable testID="host-card-wake" onPress={props.onWake}><Text>Wake</Text></Pressable>`
    const red = evaluate({ card: cardSource({ openBody, wake: '' }) })
    expect(scopeFailures(red)).toEqual([
      `${CARD}:5 effect control "host-card-wake" is nested inside "host-card-open" — an effect control is a sibling of the other controls, never inside one`
    ])
    expect(evaluate().failures).toEqual([])
  })

  it('unbacked effect: wording inside an effect control whose rpc is not a host method fails', () => {
    const wake = `<Pressable testID="host-card-wake" onPress={props.onWake}><Text>Wake</Text></Pressable>`
    const red = evaluate({ card: cardSource({ wake }), extraRpc: [] })
    expect(scopeFailures(red).filter((failure) => WORDING('Wake').test(failure))).toHaveLength(1)
    expect(
      red.failures.filter((failure) => /rpc "host\.wake\.request" is not a host RPC/.test(failure))
    ).toHaveLength(1)
    expect(evaluate({ card: cardSource({ wake }) }).failures).toEqual([])
  })

  it('siblings: two effect controls legitimize only their own extents, not the text between', () => {
    const second = `<Pressable testID="host-card-boot" onPress={props.onBoot}><Text>Boot</Text></Pressable>`
    const first = `<Pressable testID="host-card-wake" onPress={props.onWake}><Text>Wake</Text></Pressable>`
    const actions = {
      ...wakeActions(),
      'host-card-boot': {
        kind: 'effect',
        rpc: 'host.boot',
        why: 'boots the host through its broker'
      }
    }
    const extraRpc = [WAKE_RPC, 'host.boot']
    const red = evaluate({
      card: cardSource({ wake: `${first}\n<Text>Wake all</Text>\n${second}` }),
      actions,
      extraRpc
    })
    expect(scopeFailures(red)).toHaveLength(1)
    expect(scopeFailures(red)[0]).toMatch(WORDING('Wake all'))
    const green = evaluate({ card: cardSource({ wake: `${first}\n${second}` }), actions, extraRpc })
    expect(green.failures).toEqual([])
  })

  it('attributes: a literal accessibilityLabel on the effect control passes', () => {
    const wake = `<Pressable testID="host-card-wake" accessibilityLabel="Wake host" onPress={props.onWake} />`
    expect(evaluate({ card: cardSource({ wake }) }).failures).toEqual([])
  })

  it('attributes: the same label on a navigation control fails through checkAction and the scope', () => {
    const red = evaluate({ card: cardSource({ actionsAttrs: 'accessibilityLabel="Wake host"' }) })
    expect(
      red.failures.filter((f) =>
        /navigation control "host-card-actions" uses effect wording/.test(f)
      )
    ).toHaveLength(1)
    expect(scopeFailures(red).filter((failure) => WORDING('Wake host').test(failure))).toHaveLength(
      1
    )
  })

  it('template: a template literal inside the effect extent passes', () => {
    const wake =
      '<Pressable testID="host-card-wake" onPress={props.onWake}><Text>{`Wake ${props.host.name}`}</Text></Pressable>'
    expect(evaluate({ card: cardSource({ wake }) }).failures).toEqual([])
  })

  it('template: the same template literal outside every control fails', () => {
    const red = evaluate({
      card: cardSource({ after: '<Text>{`Wake ${props.host.name}`}</Text>' })
    })
    expect(scopeFailures(red)).toHaveLength(1)
    expect(scopeFailures(red)[0]).toMatch(WORDING('Wake ${props.host.name}'))
  })

  it('imports: an import specifier naming wake in the card fails; the wake projection comes through props', () => {
    const red = evaluate({
      card: cardSource({ imports: `import { useHostWake } from './use-host-wake'` })
    })
    expect(scopeFailures(red)).toHaveLength(1)
    expect(scopeFailures(red)[0]).toMatch(WORDING('./use-host-wake'))
    const twin = evaluate({
      card: cardSource({ imports: `import { useHostCard } from './use-host-card'` })
    })
    expect(twin.failures).toEqual([])
  })

  it("self-closing: wording right after a self-closing effect control's /> fails", () => {
    const red = evaluate({ card: cardSource({ wake: `${WAKE_SIBLING}Wake now` }) })
    expect(scopeFailures(red)).toHaveLength(1)
    expect(scopeFailures(red)[0]).toMatch(WORDING('Wake now'))
    const wake = `<Pressable testID="host-card-wake" onPress={props.onWake}>Wake now</Pressable>`
    expect(evaluate({ card: cardSource({ wake }) }).failures).toEqual([])
  })

  it('depth: an inner same-name element does not end the effect extent early', () => {
    const wake = `<Pressable testID="host-card-wake" onPress={props.onWake}>
<Pressable testID="host-card-detail" onPress={props.onDetail}><Text>Details</Text></Pressable>
<Text>Wake</Text>
</Pressable>`
    const actions = {
      ...wakeActions(),
      'host-card-detail': { kind: 'navigation', why: 'opens the wake detail sheet on the phone' }
    }
    expect(evaluate({ card: cardSource({ wake }), actions }).failures).toEqual([])
    const after = `<Text>Wake</Text>`
    const red = evaluate({
      card: cardSource({ wake: wake.replace('<Text>Wake</Text>\n', ''), after }),
      actions
    })
    expect(scopeFailures(red)).toHaveLength(1)
  })

  it('depth: jsxElements ends an outer element at its own close, a self-closing one at its />', () => {
    const source = '<Pressable a={1}><Pressable b />x<Pressable c>y</Pressable>z</Pressable>w'
    const [outer, selfClosing, inner] = jsxElements(source, 'Pressable')
    expect(source.slice(outer.end)).toBe('w')
    expect(source.slice(selfClosing.start, selfClosing.end)).toBe('<Pressable b />')
    expect(source.slice(inner.end)).toBe('z</Pressable>w')
  })

  it('comments: Wake inside // or /* */ comments outside every control is ignored', () => {
    const after = `{/* Wake the host from here */}\n// <Text>Wake</Text>`
    expect(evaluate({ card: cardSource({ after }) }).failures).toEqual([])
  })
})
