import { describe, expect, it } from 'vitest'

import { MIN_LABELS, MIN_RPC_METHODS, evaluateHostCardClaims } from './check-host-card-claims.mjs'

// G8 copy reach (21-REVIEW WR-04): synthetic card, presenter, presenter helper and child component.
// Every red case has a green twin; the boundary row pins what the reach does not follow.

const CARD = 'app/HostCard.tsx'
const PRESENTER = 'app/host-presentation.ts'
const HELPER = 'app/wake-stage-copy.ts'
const CHILD = 'app/WakeBadge.tsx'
const OUTSIDE = 'shared/other-copy.ts'
const MODEL = 'shared/model.ts'

const VOCAB = {
  HOST_EVIDENCE_KINDS: ['live-response'],
  HOST_POWER_STATES: Array.from({ length: MIN_LABELS }, (_, i) => `awake-${i}`),
  HOST_ORCA_STATES: ['unknown'],
  HOST_CAPABILITY_IDS: ['can-wake-lan'],
  HOST_CAPABILITY_VALUES: ['unknown']
}

const PRESENTER_BODY = `export function stageTone(stage) {
  return stage === 'packet-sent' ? 'warning' : 'muted'
}`
const HELPER_BODY = `export function helperId(stage) {
  return stage === 'host-announced' ? 'answered' : null
}`
const CHILD_BODY = `export function WakeBadge(props) {
  return <Text style={styles.badge}>{props.text}</Text>
}`

function presenterSource(body = PRESENTER_BODY) {
  const rows = Array.from({ length: MIN_LABELS }, (_, i) => `  'power.awake-${i}': 'Awake',`)
  return `import { compose } from '../shared/model'
import { helperId } from './wake-stage-copy'
import { outsideText } from '../shared/other-copy'
export const HOST_CARD_LABELS = {
${rows.join('\n')}
} as const
export function presentHostCardAvailability() { return compose() }
${body}
`
}

const CARD_SOURCE = `import { presentHostCardAvailability } from './host-presentation'
import { WakeBadge } from './WakeBadge'
export function HostCard(props) {
  return (<View>
<Pressable testID="host-card-open" onPress={props.onPress} />
<Pressable testID="host-card-actions" onPress={props.onOpenActions} />
<Pressable testID="host-card-wake" onPress={props.onWake} />
<WakeBadge text={props.stage} />
</View>)
}
`

const ACTIONS = {
  'host-card-open': { kind: 'navigation', why: 'opens the host screen on the phone' },
  'host-card-actions': { kind: 'navigation', why: 'opens the phone-local actions sheet' },
  'host-card-wake': { kind: 'effect', rpc: 'host.wake.request', why: 'sends a wake request' }
}

function evaluate({
  presenter = PRESENTER_BODY,
  helper = HELPER_BODY,
  child = CHILD_BODY,
  outside = "export function outsideText() { return 'Woken' }"
} = {}) {
  const presenterText = presenterSource(presenter)
  const labels = {}
  for (let i = 0; i < MIN_LABELS; i++) {
    labels[`power.awake-${i}`] = {
      producer: `${MODEL}#compose`,
      evidence: ['live-response'],
      why: 'the composer proves this from the live answer'
    }
  }
  const files = new Map([
    [CARD, CARD_SOURCE],
    [PRESENTER, presenterText]
  ])
  const repo = {
    [MODEL]: 'export function compose() {}\n',
    [HELPER]: `${helper}\n`,
    [CHILD]: `${child}\n`,
    [OUTSIDE]: `${outside}\n`
  }
  return evaluateHostCardClaims({
    config: { card: CARD, presenter: PRESENTER, model: MODEL, labels, actions: ACTIONS },
    files,
    read: (p) => files.get(p) ?? repo[p] ?? null,
    rpcMethods: new Set([
      ...Array.from({ length: MIN_RPC_METHODS }, (_, i) => `m.${i}`),
      'host.wake.request'
    ]),
    vocab: VOCAB
  })
}

function failing(result, pattern) {
  return result.failures.filter((failure) => pattern.test(failure))
}

describe('G8 card copy reach (WR-04)', () => {
  it('passes the clean card and counts card, presenter, child and presenter helper', () => {
    const result = evaluate()

    expect(result.failures).toEqual([])
    expect(result.copyModuleCount).toBe(4)
  })

  it('presenter: a literal returned outside HOST_CARD_LABELS may not say the host woke', () => {
    const red = evaluate({
      presenter: `export function stageText(stage) {
  return stage === 'packet-sent' ? 'Host woken' : null
}`
    })
    const twin = evaluate({
      presenter: `export function stageText(stage) {
  return stage === 'packet-sent' ? 'Packet left the broker' : null
}`
    })

    expect(
      failing(red, /^app\/host-presentation\.ts:\d+ copy "Host woken" reads as a woken host/)
    ).toHaveLength(1)
    expect(twin.failures).toEqual([])
  })

  it('presenter: an identifier-shaped literal is split, so host-woken is still copy', () => {
    const red = evaluate({ presenter: "export const STAGE = 'host-woken'" })
    const twin = evaluate({ presenter: "export const STAGE = 'host-answered'" })

    expect(failing(red, /copy "host-woken" reads as a woken host/)).toHaveLength(1)
    expect(twin.failures).toEqual([])
  })

  it('presenter: effect wording outside HOST_CARD_LABELS fails, a plain fact does not', () => {
    const red = evaluate({ presenter: "export function hint() { return 'Power on the desk PC' }" })
    const twin = evaluate({ presenter: "export function hint() { return 'Desk PC is far' }" })

    expect(
      failing(red, /^app\/host-presentation\.ts:\d+ effect wording "Power on the desk PC" outside/)
    ).toHaveLength(1)
    expect(twin.failures).toEqual([])
  })

  it('follows the presenter into its own helper module, transitively', () => {
    const red = evaluate({ helper: "export function helperId() { return 'Back online' }" })

    expect(
      failing(red, /^app\/wake-stage-copy\.ts:\d+ copy "Back online" reads as a woken host/)
    ).toHaveLength(1)
  })

  it('child component: effect wording outside any backed effect control fails', () => {
    const red = evaluate({
      child: `export function WakeBadge(props) {
  return <View><Text>Power on</Text></View>
}`
    })
    const twin = evaluate({
      child: `export function WakeBadge(props) {
  return <Pressable testID="host-card-wake" onPress={props.onWake}><Text>Wake</Text></Pressable>
}`
    })

    expect(
      failing(
        red,
        /^app\/WakeBadge\.tsx:\d+ effect wording "Power on" but no effect control classified to a host RPC method encloses it/
      )
    ).toHaveLength(1)
    expect(twin.failures).toEqual([])
  })

  it('child component: effect wording inside a navigation control still fails', () => {
    const red = evaluate({
      child: `export function WakeBadge(props) {
  return <Pressable testID="host-card-open" onPress={props.onPress}><Text>Wake</Text></Pressable>
}`
    })

    expect(failing(red, /^app\/WakeBadge\.tsx:\d+ effect wording "Wake"/)).toHaveLength(1)
  })

  it('child component: JSX text may not say the host woke', () => {
    const red = evaluate({
      child: `export function WakeBadge(props) {
  return <View><Text>Woken</Text></View>
}`
    })

    expect(
      failing(red, /^app\/WakeBadge\.tsx:\d+ copy "Woken" reads as a woken host/)
    ).toHaveLength(1)
  })

  it('known limit: a module outside the card directory is not followed (jsonc header)', () => {
    const result = evaluate()

    expect(failing(result, /other-copy/)).toEqual([])
    expect(result.copyModuleCount).toBe(4)
  })
})
