import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse } from 'jsonc-parser'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CONFIG_PATH,
  MIN_LABELS,
  MIN_RPC_METHODS,
  evaluateHostCardClaims,
  labelTable,
  main
} from './check-host-card-claims.mjs'
// Why a namespace: a missing export fails only the rows that use it, not the whole file.
import * as effectClaims from './host-card-effect-claims.mjs'

// Synthetic card and presenter, except the real-repo rows: every red case has a green twin.

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const CARD = 'app/HostCard.tsx'
const PRESENTER = 'app/host-presentation.ts'
const MODEL = 'shared/model.ts'
const WAKE_RPC = 'host.wake.request'
const SUCCESS_SHAPE =
  /^check-host-card-claims: \d+ labels classified, \d+ controls classified, \d+ host RPC methods known, no unevidenced power-loss state, no control without an effect, \d+ capability producers classified, \d+ capability emitters scanned, \d+ card copy modules scanned\.$/

const VOCAB = {
  HOST_EVIDENCE_KINDS: ['live-response'],
  HOST_POWER_STATES: Array.from({ length: MIN_LABELS }, (_, i) => `awake-${i}`),
  HOST_ORCA_STATES: ['unknown'],
  HOST_CAPABILITY_IDS: ['can-wake-lan'],
  HOST_CAPABILITY_VALUES: ['unknown']
}

const WAKE_MODEL = 'src/shared/host-wake.ts'
const WAKE_TARGET_PRODUCER = `${WAKE_MODEL}#composeWakeProgress`
const WAKE_ARRAYS = {
  HOST_WAKE_STAGES: ['requested', 'authorized', 'packet-sent', 'host-announced', 'runtime-ready'],
  HOST_WAKE_BROKER_STAGES: ['requested', 'authorized', 'packet-sent'],
  HOST_WAKE_REFUSAL_CODES: ['wake_grant_missing', 'wake_unknown'],
  HOST_WAKE_CARD_STATES: ['packet-send-failed', 'unknown', 'ambiguous-broker']
}
const wakeModelSource = `${Object.entries(WAKE_ARRAYS)
  .map(([name, items]) => `export const ${name} = [\n  '${items.join("',\n  '")}'\n] as const`)
  .join('\n')}
export function composeWakeProgress() {}
`
const WAKE_VOCAB = {
  ...VOCAB,
  ...WAKE_ARRAYS,
  HOST_WAKE_CARD_VOCABULARY: [
    ...WAKE_ARRAYS.HOST_WAKE_STAGES,
    ...WAKE_ARRAYS.HOST_WAKE_REFUSAL_CODES,
    ...WAKE_ARRAYS.HOST_WAKE_CARD_STATES
  ]
}

function presenterSource(wake = []) {
  const rows = Array.from({ length: MIN_LABELS }, (_, i) => `  'power.awake-${i}': 'Awake',`)
  for (const { key, text } of wake) {
    rows.push(`  '${key}': '${text}',`)
  }
  return `import { compose } from '../shared/model'
import { composeWakeProgress } from '../src/shared/host-wake'
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

function evaluate({
  card = cardSource(),
  actions = wakeActions(),
  extraRpc = [WAKE_RPC],
  wake = [],
  vocab = VOCAB
} = {}) {
  const presenter = presenterSource(wake)
  const labels = {}
  for (const row of labelTable(presenter)) {
    labels[row.key] = {
      producer: `${MODEL}#compose`,
      evidence: ['live-response'],
      why: 'the composer proves this from the live answer'
    }
  }
  for (const { key, entry } of wake) {
    labels[key] = entry
  }
  const files = new Map([
    [CARD, card],
    [PRESENTER, presenter]
  ])
  const repo = { [MODEL]: 'export function compose() {}\n', [WAKE_MODEL]: wakeModelSource }
  const rpcMethods = new Set([
    ...Array.from({ length: MIN_RPC_METHODS }, (_, i) => `m.${i}`),
    ...extraRpc
  ])
  return evaluateHostCardClaims({
    config: { card: CARD, presenter: PRESENTER, model: MODEL, labels, actions },
    files,
    read: (p) => files.get(p) ?? repo[p] ?? null,
    rpcMethods,
    vocab
  })
}

/** One wake label row: broker-observed, composed, live-response, unless `patch` says otherwise. */
function wakeRow(key, text, patch = {}) {
  return {
    key,
    text,
    entry: {
      observer: 'broker',
      producer: WAKE_TARGET_PRODUCER,
      evidence: ['live-response'],
      why: 'the broker reply on this connection names this stage',
      ...patch
    }
  }
}

function failing(result, pattern) {
  return result.failures.filter((failure) => pattern.test(failure))
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
    const [outer, selfClosing, inner] = effectClaims.jsxElements(source, 'Pressable')
    expect(source.slice(outer.end)).toBe('w')
    expect(source.slice(selfClosing.start, selfClosing.end)).toBe('<Pressable b />')
    expect(source.slice(inner.end)).toBe('z</Pressable>w')
  })

  it('comments: Wake inside // or /* */ comments outside every control is ignored', () => {
    const after = `{/* Wake the host from here */}\n// <Text>Wake</Text>`
    expect(evaluate({ card: cardSource({ after }) }).failures).toEqual([])
  })
})

const ANNOUNCED = 'Host answered after wake'
const target = (patch = {}) => ({ observer: 'target', ...patch })

describe('host-card-effect-claims: wake label family (G7 vocabulary and claims)', () => {
  it('vocabulary: stages, refusal codes and card states are wake suffixes; woken is not', () => {
    const wake = [
      wakeRow('wake.packet-sent', 'Wake packet sent'),
      wakeRow('wake.wake_grant_missing', 'Wake refused: no grant', {
        producer: `${WAKE_MODEL}#HOST_WAKE_REFUSAL_CODES`
      }),
      wakeRow('wake.ambiguous-broker', 'Wake unavailable: ambiguous broker', {
        observer: 'phone',
        producer: `${WAKE_MODEL}#HOST_WAKE_CARD_STATES`
      })
    ]
    expect(evaluate({ wake, vocab: WAKE_VOCAB }).failures).toEqual([])
    const red = evaluate({
      wake: [...wake, wakeRow('wake.woken', 'Wake finished')],
      vocab: WAKE_VOCAB
    })
    expect(failing(red, /"woken" is not in HOST_WAKE_CARD_VOCABULARY/)).toHaveLength(1)
  })

  it('claim family: wake.unknown must say unknown with no evidence; a stage needs evidence', () => {
    const unknown = (text) =>
      wakeRow('wake.unknown', text, {
        observer: 'phone',
        producer: `${WAKE_MODEL}#HOST_WAKE_CARD_STATES`,
        evidence: []
      })
    expect(
      evaluate({ wake: [unknown('Wake status unknown')], vocab: WAKE_VOCAB }).failures
    ).toEqual([])
    const pending = evaluate({ wake: [unknown('Wake pending')], vocab: WAKE_VOCAB })
    expect(
      failing(pending, /"wake\.unknown" must say unknown, but reads "Wake pending"/)
    ).toHaveLength(1)
    const bare = evaluate({
      wake: [wakeRow('wake.packet-sent', 'Wake packet sent', { evidence: [] })],
      vocab: WAKE_VOCAB
    })
    expect(failing(bare, /"wake\.packet-sent" claims a state but names no evidence/)).toHaveLength(
      1
    )
  })

  it('non-vacuity: wake labels with no wake vocabulary fail, never pass unchecked', () => {
    const wake = [wakeRow('wake.packet-sent', 'Wake packet sent')]
    const red = evaluate({ wake, vocab: VOCAB })
    expect(
      failing(red, /wake label\(s\) but no wake vocabulary \(HOST_WAKE_CARD_VOCABULARY\)/)
    ).toHaveLength(1)
    expect(evaluate({ wake, vocab: WAKE_VOCAB }).failures).toEqual([])
  })
})

describe('host-card-effect-claims: observer rule (W1-W3, broker versus target evidence)', () => {
  it('W1: a wake label without an observer, or with relay, fails; broker passes', () => {
    const missing = evaluate({
      wake: [wakeRow('wake.requested', 'Wake requested', { observer: undefined })],
      vocab: WAKE_VOCAB
    })
    expect(
      failing(missing, /"wake\.requested": observer missing is not broker, target or phone/)
    ).toHaveLength(1)
    const relay = evaluate({
      wake: [wakeRow('wake.requested', 'Wake requested', { observer: 'relay' })],
      vocab: WAKE_VOCAB
    })
    expect(
      failing(relay, /"wake\.requested": observer "relay" is not broker, target or phone/)
    ).toHaveLength(1)
    const broker = evaluate({
      wake: [wakeRow('wake.requested', 'Wake requested')],
      vocab: WAKE_VOCAB
    })
    expect(broker.failures).toEqual([])
  })

  it('W2: a broker stage observed by the target fails', () => {
    const red = evaluate({
      wake: [wakeRow('wake.packet-sent', 'Wake packet sent', target())],
      vocab: WAKE_VOCAB
    })
    expect(
      failing(red, /"wake\.packet-sent": observer target is only for host-announced, runtime-ready/)
    ).toHaveLength(1)
  })

  it('W2: host-announced observed by the broker fails', () => {
    const red = evaluate({ wake: [wakeRow('wake.host-announced', ANNOUNCED)], vocab: WAKE_VOCAB })
    expect(failing(red, /"wake\.host-announced": observer must be target/)).toHaveLength(1)
  })

  it('W2: host-announced from a producer other than composeWakeProgress fails', () => {
    const red = evaluate({
      wake: [
        wakeRow(
          'wake.host-announced',
          ANNOUNCED,
          target({ producer: `${WAKE_MODEL}#HOST_WAKE_STAGES` })
        )
      ],
      vocab: WAKE_VOCAB
    })
    expect(
      failing(
        red,
        /"wake\.host-announced": producer must be src\/shared\/host-wake\.ts#composeWakeProgress/
      )
    ).toHaveLength(1)
  })

  it('W2: host-announced without live-response evidence fails', () => {
    const red = evaluate({
      wake: [wakeRow('wake.host-announced', ANNOUNCED, target({ evidence: [] }))],
      vocab: WAKE_VOCAB
    })
    expect(
      failing(red, /"wake\.host-announced": evidence must be exactly \["live-response"\]/)
    ).toHaveLength(1)
  })

  it('W2: host-announced from composeWakeProgress with live-response, observed by the target, passes', () => {
    const green = evaluate({
      wake: [wakeRow('wake.host-announced', ANNOUNCED, target())],
      vocab: WAKE_VOCAB
    })
    expect(green.failures).toEqual([])
  })

  it('W3: a broker stage reading Woken fails (the D-09 shape); Wake requested passes', () => {
    const red = evaluate({ wake: [wakeRow('wake.packet-sent', 'Woken')], vocab: WAKE_VOCAB })
    expect(failing(red, /"wake\.packet-sent" reads "Woken"/)).toHaveLength(1)
    const green = evaluate({
      wake: [wakeRow('wake.requested', 'Wake requested')],
      vocab: WAKE_VOCAB
    })
    expect(green.failures).toEqual([])
  })

  it('W3: the target may say ready; the same words on a phone label fail', () => {
    const ready = 'Orca runtime ready after wake'
    const green = evaluate({
      wake: [wakeRow('wake.runtime-ready', ready, target())],
      vocab: WAKE_VOCAB
    })
    expect(green.failures).toEqual([])
    const red = evaluate({
      wake: [
        wakeRow('wake.ambiguous-broker', 'Host online', {
          observer: 'phone',
          producer: `${WAKE_MODEL}#HOST_WAKE_CARD_STATES`
        })
      ],
      vocab: WAKE_VOCAB
    })
    expect(failing(red, /"wake\.ambiguous-broker" reads "Host online"/)).toHaveLength(1)
  })

  it('WOKEN_WORDING names a woken host and leaves the broker copy alone', () => {
    for (const text of ['Woken', 'Host awake', 'Back online', 'Up', 'Ready', 'Booted']) {
      expect(effectClaims.WOKEN_WORDING.test(text)).toBe(true)
    }
    for (const text of [
      'Wake requested',
      'Wake packet sent',
      'Wake refused: broker state unconfirmed'
    ]) {
      expect(effectClaims.WOKEN_WORDING.test(text)).toBe(false)
    }
  })
})

describe('host-card-effect-claims: wakeModel (G7 non-vacuity)', () => {
  it('reads the four wake arrays and their union from a model', () => {
    const vocab = effectClaims.wakeVocabulary(wakeModelSource)
    expect(vocab).toEqual({
      ...WAKE_ARRAYS,
      HOST_WAKE_CARD_VOCABULARY: WAKE_VOCAB.HOST_WAKE_CARD_VOCABULARY
    })
    expect(effectClaims.wakeVocabulary('')).toEqual({})
  })

  it('reads the real host-wake.ts, a commented member list included', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, WAKE_MODEL), 'utf8')
    const vocab = effectClaims.wakeVocabulary(source)
    expect(vocab.HOST_WAKE_REFUSAL_CODES).toContain('host_key_unavailable')
    expect(vocab.HOST_WAKE_REFUSAL_CODES.every((code) => /^[a-z_]+$/.test(code))).toBe(true)
    expect(vocab.HOST_WAKE_CARD_STATES).toEqual([
      'packet-send-failed',
      'unknown',
      'ambiguous-broker'
    ])
    expect(vocab.HOST_WAKE_CARD_VOCABULARY).toContain('runtime-ready')
  })

  it('checkWakeModel fails without wakeModel and on a missing array, passes on a full model', () => {
    const missing = []
    effectClaims.checkWakeModel({ config: {}, vocab: WAKE_VOCAB, failures: missing })
    expect(missing).toEqual([expect.stringMatching(/wakeModel is missing/)])
    const partial = []
    const rest = { ...WAKE_VOCAB }
    delete rest.HOST_WAKE_CARD_STATES
    effectClaims.checkWakeModel({
      config: { wakeModel: WAKE_MODEL },
      vocab: rest,
      failures: partial
    })
    expect(partial).toEqual([`wake vocabulary HOST_WAKE_CARD_STATES not found in ${WAKE_MODEL}`])
    const full = []
    effectClaims.checkWakeModel({
      config: { wakeModel: WAKE_MODEL },
      vocab: WAKE_VOCAB,
      failures: full
    })
    expect(full).toEqual([])
  })

  it('main fails on a copy of the real config without wakeModel, naming wakeModel', async () => {
    const config = parse(fs.readFileSync(path.join(REPO_ROOT, CONFIG_PATH), 'utf8'))
    expect(config.wakeModel).toBe(WAKE_MODEL)
    delete config.wakeModel
    const { code, errors } = await runMain(JSON.stringify(config))
    expect(code).toBe(1)
    // Why two: since 21-04 the card has wake labels, so G7 non-vacuity names wakeModel as well.
    expect(errors.filter((line) => /wakeModel/.test(line))).toEqual([
      expect.stringMatching(/20 wake label\(s\) but no wake vocabulary .*set wakeModel/),
      expect.stringMatching(/wakeModel is missing from the config/)
    ])
  })
})
