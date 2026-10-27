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
function presenterSource({ extraLabels = '', dropFloor = false, body = '' } = {}) {
  const rows = BASE_LABELS.map(([key, text]) => `  '${key}': '${text}',`)
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
  vocab = VOCAB,
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
