import { describe, expect, it } from 'vitest'

import {
  MIN_LABELS,
  MIN_PRESSABLES,
  MIN_RPC_METHODS,
  evaluateHostCardClaims,
  labelTable,
  modelVocabulary,
  rpcMethodNames
} from './check-host-card-claims.mjs'

// Synthetic subjects, never the real card: a drill pinned to a real file decays the moment that
// file changes. Every red case has a green twin, so a checker that refused everything would fail.

const CARD = 'app/HostCard.tsx'
const PRESENTER = 'app/host-presentation.ts'
const MODEL = 'shared/model.ts'
const HOST = 'host/producer.ts'

const VOCAB = {
  HOST_EVIDENCE_KINDS: ['live-response', 'transport-observed', 'host-announced'],
  HOST_POWER_STATES: ['awake', 'sleeping', 'hibernating', 'powered-off', 'unknown'],
  HOST_ORCA_STATES: ['ui-open', 'unknown'],
  HOST_CAPABILITY_IDS: ['can-wake-lan', 'can-relay'],
  HOST_CAPABILITY_VALUES: ['supported', 'unknown']
}

const modelSource = `export function compose() {}
export const HOST_IDS = ['can-wake-lan'] as const
export function parse() {}
`
const hostSource = `export function createProducer() {}\n`

// Enough rows to clear the floor; each is a real family/suffix pair from VOCAB.
const BASE_LABELS = [
  ['power.awake', 'Awake', 'compose', ['live-response']],
  ['power.unknown', 'Power unknown', 'compose', []],
  ['orca.ui-open', 'Orca open', 'compose', ['live-response']],
  ['orca.unknown', 'Orca unknown', 'compose', []],
  ['capability.can-wake-lan', 'LAN wake', 'HOST_IDS', []],
  ['capability.can-relay', 'Relay', 'HOST_IDS', []],
  ['capability-value.supported', 'yes', 'parse', ['host-announced']],
  ['capability-value.unknown', 'unknown', 'parse', []],
  ['capabilities.unknown', 'Capabilities unknown', 'HOST_IDS', []]
]

// Floor rows `power.awake-<n>` keep keys unique; FLOOR_VOCAB admits their suffixes.
function presenterSource({ extraLabels = '', dropFloor = false, body = '', texts = {} } = {}) {
  const rows = BASE_LABELS.map(([key, text]) => `  '${key}': '${texts[key] ?? text}',`)
  if (!dropFloor) {
    for (let i = rows.length; i < MIN_LABELS; i++) {
      rows.push(`  'power.awake-${i}': 'Awake',`)
    }
  }
  return `import { compose, HOST_IDS, parse } from '../shared/model'
export const HOST_CARD_LABELS = {
${rows.join('\n')}
${extraLabels}
} as const
export function presentHostCardAvailability() { return 'x' }
${body}
`
}

function cardSource({ importPresenter = true, controls = null, extraJsx = '' } = {}) {
  const imp = importPresenter
    ? `import { presentHostCardAvailability } from './host-presentation'`
    : `import { somethingElse } from './host-presentation'`
  const pressables =
    controls ??
    `<Pressable testID="host-card-open" accessibilityLabel={label} onPress={props.onPress}>
  <Text>{availability.availabilityText}</Text>
</Pressable>
<Pressable testID="host-card-actions" accessibilityLabel={\`Actions for \${name}\`} onPress={props.onOpenActions} />`
  return `${imp}
export function HostCard(props) {
  return (<View>
${pressables}
${extraJsx}
</View>)
}
`
}

function labelsConfig(presenter) {
  const labels = {}
  for (const row of labelTable(presenter)) {
    const base = BASE_LABELS.find(([key]) => key === row.key)
    const [, , symbol, evidence] = base ?? ['', '', 'compose', ['live-response']]
    labels[row.key] = {
      producer: `${MODEL}#${symbol}`,
      evidence,
      why: 'the composer proves this from the live answer'
    }
  }
  return labels
}

function config({ presenter, labels, actions } = {}) {
  return {
    card: CARD,
    presenter: PRESENTER,
    model: MODEL,
    rpcMethodsDir: 'host/methods',
    labels: labels ?? labelsConfig(presenter),
    actions: actions ?? {
      'host-card-open': { kind: 'navigation', why: 'opens the host screen on the phone' },
      'host-card-actions': { kind: 'navigation', why: 'opens the phone-local actions sheet' }
    }
  }
}

function rpcSet(extra = []) {
  return new Set([...Array.from({ length: MIN_RPC_METHODS }, (_, i) => `m.${i}`), ...extra])
}

function evaluate({
  presenter = presenterSource(),
  card = cardSource(),
  labels,
  actions,
  rpcMethods = rpcSet(),
  vocab = FLOOR_VOCAB,
  repo = {}
} = {}) {
  const files = new Map([
    [CARD, card],
    [PRESENTER, presenter]
  ])
  const all = { [MODEL]: modelSource, [HOST]: hostSource, ...repo }
  const read = (p) => files.get(p) ?? all[p] ?? null
  return evaluateHostCardClaims({
    config: config({ presenter, labels, actions }),
    files,
    read,
    rpcMethods,
    vocab
  })
}

function failuresMatching(result, pattern) {
  return result.failures.filter((failure) => pattern.test(failure))
}

const FLOOR_VOCAB = {
  ...VOCAB,
  HOST_POWER_STATES: [
    ...VOCAB.HOST_POWER_STATES,
    ...Array.from({ length: MIN_LABELS }, (_, i) => `awake-${i}`)
  ]
}

describe('check-host-card-claims: coverage (G1)', () => {
  it('passes the synthetic baseline', () => {
    expect(evaluate({ vocab: FLOOR_VOCAB }).failures).toEqual([])
  })

  it('fails on an unclassified label, passes once classified', () => {
    const presenter = presenterSource({ extraLabels: `  'orca.unknown2': 'Orca unknown',` })
    const vocab = { ...FLOOR_VOCAB, HOST_ORCA_STATES: [...VOCAB.HOST_ORCA_STATES, 'unknown2'] }
    const labels = labelsConfig(presenterSource())
    const red = evaluate({ presenter, labels, vocab })
    expect(failuresMatching(red, /label "orca\.unknown2" is not classified/)).toHaveLength(1)
    const green = evaluate({ presenter, vocab })
    expect(failuresMatching(green, /not classified/)).toEqual([])
  })

  it('fails on a stale classification, passes without it', () => {
    const labels = {
      ...labelsConfig(presenterSource()),
      'orca.ui-gone': {
        producer: `${MODEL}#compose`,
        evidence: ['live-response'],
        why: 'a label the presenter dropped'
      }
    }
    expect(
      failuresMatching(
        evaluate({ labels, vocab: FLOOR_VOCAB }),
        /"orca\.ui-gone" is classified but .* stale/
      )
    ).toHaveLength(1)
    expect(failuresMatching(evaluate({ vocab: FLOOR_VOCAB }), /stale/)).toEqual([])
  })

  it('fails on a suffix outside the model vocabulary, passes inside it', () => {
    const presenter = presenterSource({ extraLabels: `  'power.napping': 'Napping',` })
    const red = evaluate({ presenter, vocab: FLOOR_VOCAB })
    expect(failuresMatching(red, /"napping" is not in HOST_POWER_STATES/)).toHaveLength(1)
    const vocab = {
      ...FLOOR_VOCAB,
      HOST_POWER_STATES: [...FLOOR_VOCAB.HOST_POWER_STATES, 'napping']
    }
    expect(failuresMatching(evaluate({ presenter, vocab }), /is not in/)).toEqual([])
  })

  it('fails when the card does not import the presenter, passes when it does', () => {
    const red = evaluate({ card: cardSource({ importPresenter: false }), vocab: FLOOR_VOCAB })
    expect(failuresMatching(red, /does not import presentHostCardAvailability/)).toHaveLength(1)
    expect(failuresMatching(evaluate({ vocab: FLOOR_VOCAB }), /does not import/)).toEqual([])
  })

  it('fails under the label floor, passes at it', () => {
    const presenter = presenterSource({ dropFloor: true })
    expect(
      failuresMatching(
        evaluate({ presenter, vocab: FLOOR_VOCAB }),
        new RegExp(`labels, expected at least ${MIN_LABELS}`)
      )
    ).toHaveLength(1)
    expect(failuresMatching(evaluate({ vocab: FLOOR_VOCAB }), /expected at least/)).toEqual([])
  })
})

describe('check-host-card-claims: controls (G5 identity)', () => {
  const twoControls = (first) => `${first}
<Pressable testID="host-card-actions" onPress={props.onOpenActions} />`

  it('fails on a Pressable without a literal testID (P18-M2b), passes with one', () => {
    const card = cardSource({
      extraJsx: `<Pressable accessibilityRole="button" onPress={props.onOpenActions} />`
    })
    const red = evaluate({ card, vocab: FLOOR_VOCAB })
    expect(failuresMatching(red, /Pressable has no literal testID/)).toHaveLength(1)
    expect(failuresMatching(evaluate({ vocab: FLOOR_VOCAB }), /no literal testID/)).toEqual([])
  })

  it('fails on an unclassified testID, passes once classified', () => {
    const card = cardSource({
      extraJsx: `<TouchableOpacity testID="host-card-extra" onPress={go} />`
    })
    const red = evaluate({ card, vocab: FLOOR_VOCAB })
    expect(failuresMatching(red, /control "host-card-extra" is not classified/)).toHaveLength(1)
    const actions = {
      ...config({ presenter: presenterSource() }).actions,
      'host-card-extra': { kind: 'navigation', why: 'opens a phone-local detail' }
    }
    expect(
      failuresMatching(evaluate({ card, actions, vocab: FLOOR_VOCAB }), /not classified/)
    ).toEqual([])
  })

  it('fails under the pressable floor, passes at it', () => {
    const card = cardSource({ controls: `<Pressable testID="host-card-open" onPress={go} />` })
    const actions = {
      'host-card-open': { kind: 'navigation', why: 'opens the host screen on the phone' }
    }
    expect(
      failuresMatching(
        evaluate({ card, actions, vocab: FLOOR_VOCAB }),
        new RegExp(`card controls, expected at least ${MIN_PRESSABLES}`)
      )
    ).toHaveLength(1)
    const twin = cardSource({
      controls: twoControls(`<Pressable testID="host-card-open" onPress={go} />`)
    })
    expect(failuresMatching(evaluate({ card: twin, vocab: FLOOR_VOCAB }), /card controls/)).toEqual(
      []
    )
  })

  it('fails under the rpc floor, passes at it', () => {
    const red = evaluate({ rpcMethods: new Set(['status.get']), vocab: FLOOR_VOCAB })
    expect(
      failuresMatching(red, new RegExp(`RPC method names, expected at least ${MIN_RPC_METHODS}`))
    ).toHaveLength(1)
    expect(failuresMatching(evaluate({ vocab: FLOOR_VOCAB }), /RPC method names/)).toEqual([])
  })
})

describe('check-host-card-claims: scanners', () => {
  it('reads the label table with keys, families and text', () => {
    const rows = labelTable(presenterSource())
    expect(rows[0]).toMatchObject({
      key: 'power.awake',
      family: 'power',
      suffix: 'awake',
      text: 'Awake'
    })
    expect(rows.find((row) => row.key === 'capability-value.supported')?.family).toBe(
      'capability-value'
    )
  })

  it('reads method names from non-test files only', () => {
    const names = rpcMethodNames({
      'm/status.ts': `defineMethod({\n  name: 'status.get',\n  params: null })`,
      'm/status.test.ts': `defineMethod({ name: 'test.only' })`
    })
    expect([...names]).toEqual(['status.get'])
  })

  it('reads the model vocabulary arrays', () => {
    const vocab = modelVocabulary(
      `export const HOST_EVIDENCE_KINDS = [\n  'live-response',\n  'os-probe'\n] as const`
    )
    expect(vocab.HOST_EVIDENCE_KINDS).toEqual(['live-response', 'os-probe'])
    expect(vocab.HOST_POWER_STATES).toBeUndefined()
  })
})

function withLabel(presenter, key, patch) {
  const labels = labelsConfig(presenter)
  labels[key] = { ...labels[key], ...patch }
  return labels
}

const POWERED_OFF = `  'power.powered-off': 'Powered off',`

describe('check-host-card-claims: producers (G2)', () => {
  it('fails when the producer module is missing, passes when it exists', () => {
    const labels = withLabel(presenterSource(), 'power.awake', {
      producer: 'shared/missing.ts#compose'
    })
    expect(
      failuresMatching(evaluate({ labels }), /producer module shared\/missing\.ts does not exist/)
    ).toHaveLength(1)
    expect(failuresMatching(evaluate(), /producer/)).toEqual([])
  })

  it('fails when the module lacks the export, passes when it exports it', () => {
    const labels = withLabel(presenterSource(), 'power.awake', { producer: `${MODEL}#composeGone` })
    expect(
      failuresMatching(evaluate({ labels }), /shared\/model\.ts does not export composeGone/)
    ).toHaveLength(1)
    expect(failuresMatching(evaluate(), /does not export/)).toEqual([])
  })

  it('fails when the presenter does not import the producer module, passes when it does', () => {
    const repo = { 'shared/other.ts': 'export function compose() {}\n' }
    const labels = withLabel(presenterSource(), 'power.awake', {
      producer: 'shared/other.ts#compose'
    })
    expect(
      failuresMatching(
        evaluate({ labels, repo }),
        /shared\/other\.ts is not imported by the presenter/
      )
    ).toHaveLength(1)
    const presenter = presenterSource({ body: "import { compose as c2 } from '../shared/other'" })
    const twin = withLabel(presenter, 'power.awake', { producer: 'shared/other.ts#compose' })
    expect(failuresMatching(evaluate({ presenter, labels: twin, repo }), /not imported/)).toEqual(
      []
    )
  })

  it('fails on a hostProducer without its export, passes with it', () => {
    const presenter = presenterSource()
    const red = withLabel(presenter, 'capability-value.supported', {
      hostProducer: `${HOST}#gone`
    })
    expect(
      failuresMatching(
        evaluate({ labels: red }),
        /hostProducer host\/producer\.ts does not export gone/
      )
    ).toHaveLength(1)
    const green = withLabel(presenter, 'capability-value.supported', {
      hostProducer: `${HOST}#createProducer`
    })
    expect(failuresMatching(evaluate({ labels: green }), /hostProducer/)).toEqual([])
  })
})

describe('check-host-card-claims: evidence (G3)', () => {
  it('fails on an evidence kind outside the vocabulary, passes inside it', () => {
    const labels = withLabel(presenterSource(), 'power.awake', { evidence: ['guess'] })
    expect(
      failuresMatching(evaluate({ labels }), /evidence "guess" is not in HOST_EVIDENCE_KINDS/)
    ).toHaveLength(1)
    expect(failuresMatching(evaluate(), /HOST_EVIDENCE_KINDS/)).toEqual([])
  })

  it('fails on an unknown claim carrying evidence, passes with none', () => {
    const labels = withLabel(presenterSource(), 'power.unknown', { evidence: ['live-response'] })
    expect(
      failuresMatching(
        evaluate({ labels }),
        /"power\.unknown" is unknown and must carry no evidence/
      )
    ).toHaveLength(1)
    expect(failuresMatching(evaluate(), /must carry no evidence/)).toEqual([])
  })

  it('fails on an unknown text that does not say unknown (P18-M1a shape), passes when it does', () => {
    const presenter = presenterSource({ texts: { 'power.unknown': 'No answer' } })
    expect(
      failuresMatching(evaluate({ presenter }), /"power\.unknown" must say unknown/)
    ).toHaveLength(1)
    expect(failuresMatching(evaluate(), /must say unknown/)).toEqual([])
  })

  it('fails on a state claim with empty evidence, passes with evidence', () => {
    const labels = withLabel(presenterSource(), 'orca.ui-open', { evidence: [] })
    expect(
      failuresMatching(evaluate({ labels }), /"orca\.ui-open" claims a state but names no evidence/)
    ).toHaveLength(1)
    expect(failuresMatching(evaluate(), /names no evidence/)).toEqual([])
  })

  it('fails on a capability name carrying evidence, passes with none', () => {
    const labels = withLabel(presenterSource(), 'capability.can-relay', {
      evidence: ['host-announced']
    })
    expect(
      failuresMatching(
        evaluate({ labels }),
        /"capability\.can-relay" is a name and carries no evidence/
      )
    ).toHaveLength(1)
    expect(failuresMatching(evaluate(), /is a name/)).toEqual([])
  })

  it('fails loudly when the model lacks a vocabulary array, never as an empty vocabulary', () => {
    const partial = modelVocabulary(`export const HOST_POWER_STATES = ['awake'] as const`)
    expect(
      failuresMatching(evaluate({ vocab: partial }), /vocabulary HOST_EVIDENCE_KINDS not found/)
    ).toHaveLength(1)
    expect(failuresMatching(evaluate(), /vocabulary .* not found/)).toEqual([])
  })
})

describe('check-host-card-claims: power-loss (G4)', () => {
  it('fails on power-loss text on power.unknown (P18-M1a), passes on the unknown text', () => {
    const presenter = presenterSource({ texts: { 'power.unknown': 'Powered off' } })
    expect(
      failuresMatching(evaluate({ presenter }), /power-loss text "Powered off" on "power\.unknown"/)
    ).toHaveLength(1)
    expect(failuresMatching(evaluate(), /power-loss/)).toEqual([])
  })

  it('fails on power.powered-off with no evidence (P18-M1b), passes with host-announced', () => {
    const presenter = presenterSource({ extraLabels: POWERED_OFF })
    const red = withLabel(presenter, 'power.powered-off', { evidence: [] })
    expect(
      failuresMatching(
        evaluate({ presenter, labels: red }),
        /power-loss label "power\.powered-off" has no evidence/
      )
    ).toHaveLength(1)
    const green = withLabel(presenter, 'power.powered-off', { evidence: ['host-announced'] })
    expect(evaluate({ presenter, labels: green }).failures).toEqual([])
  })

  it('fails on power.powered-off with a null producer, passes with a producer', () => {
    const presenter = presenterSource({ extraLabels: POWERED_OFF })
    const red = withLabel(presenter, 'power.powered-off', {
      producer: null,
      evidence: ['host-announced']
    })
    expect(
      failuresMatching(
        evaluate({ presenter, labels: red }),
        /power-loss label "power\.powered-off" has no producer/
      )
    ).toHaveLength(1)
    const green = withLabel(presenter, 'power.powered-off', { evidence: ['host-announced'] })
    expect(failuresMatching(evaluate({ presenter, labels: green }), /no producer/)).toEqual([])
  })

  it('fails on a power-loss literal in the card outside the table, passes inside comments', () => {
    const red = cardSource({ extraJsx: `{connected ? null : <Text>{'Host offline'}</Text>}` })
    expect(
      failuresMatching(
        evaluate({ card: red }),
        /power-loss copy "Host offline" outside HOST_CARD_LABELS/
      )
    ).toHaveLength(1)
    const green = cardSource({ extraJsx: `{/* Host offline */}\n  // 'Host offline'` })
    expect(failuresMatching(evaluate({ card: green }), /power-loss/)).toEqual([])
  })

  it('fails on power-loss JSX text in the card, passes in a full-line comment', () => {
    const red = cardSource({ extraJsx: `<Text>Sleeping</Text>` })
    expect(failuresMatching(evaluate({ card: red }), /power-loss copy "Sleeping"/)).toHaveLength(1)
    const green = cardSource({ extraJsx: `  // <Text>Sleeping</Text>` })
    expect(failuresMatching(evaluate({ card: green }), /power-loss/)).toEqual([])
  })

  it('fails on a power-loss literal in the presenter outside the table, passes without it', () => {
    const presenter = presenterSource({ body: "const fallback = 'asleep'" })
    expect(
      failuresMatching(evaluate({ presenter }), /power-loss copy "asleep" outside HOST_CARD_LABELS/)
    ).toHaveLength(1)
    const twin = presenterSource({ body: "// const fallback = 'asleep'" })
    expect(failuresMatching(evaluate({ presenter: twin }), /power-loss/)).toEqual([])
  })
})

describe('check-host-card-claims: effects (G5)', () => {
  const wake = `<Pressable testID="host-card-wake" accessibilityRole="button" accessibilityLabel="Wake host" onPress={props.onOpenActions} />`
  const wakeActions = (rpc) => ({
    ...config({ presenter: presenterSource() }).actions,
    'host-card-wake': { kind: 'effect', rpc, why: 'sends a wake request to the host' }
  })

  it('fails on an effect whose rpc is not a host method (P18-M2a), passes when it is', () => {
    const card = cardSource({ extraJsx: wake })
    const red = evaluate({ card, actions: wakeActions('host.wake') })
    expect(failuresMatching(red, /rpc "host\.wake" is not a host RPC method/)).toHaveLength(1)
    const green = evaluate({
      card,
      actions: wakeActions('host.wake'),
      rpcMethods: rpcSet(['host.wake'])
    })
    expect(green.failures).toEqual([])
  })

  it('fails on a navigation control whose label says Wake, passes with a neutral label', () => {
    const controls = `<Pressable testID="host-card-open" onPress={props.onPress} />
<Pressable testID="host-card-actions" accessibilityLabel="Wake host" onPress={props.onOpenActions} />`
    const red = evaluate({ card: cardSource({ controls }) })
    expect(
      failuresMatching(red, /navigation control "host-card-actions" uses effect wording/)
    ).toHaveLength(1)
    expect(failuresMatching(evaluate(), /effect wording/)).toEqual([])
  })

  it('fails on Power on copy with no effect control, passes with one classified to a real rpc', () => {
    const red = evaluate({ card: cardSource({ extraJsx: `<Text>Power on</Text>` }) })
    expect(failuresMatching(red, /effect wording "Power on" but no effect control/)).toHaveLength(1)
    const card = cardSource({
      extraJsx: `<Pressable testID="host-card-wake" onPress={props.onWake}><Text>Power on</Text></Pressable>`
    })
    const green = evaluate({
      card,
      actions: wakeActions('host.powerOn'),
      rpcMethods: rpcSet(['host.powerOn'])
    })
    expect(green.failures).toEqual([])
  })
})
