import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MIN_LABELS,
  MIN_RPC_METHODS,
  evaluateHostCardClaims,
  labelTable,
  main
} from './check-host-card-claims.mjs'

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

function cardSource({ openBody = '', wake = WAKE_SIBLING, after = '' } = {}) {
  return `import { presentHostCardAvailability } from './host-presentation'
export function HostCard(props) {
  return (<View>
<Pressable testID="host-card-open" onPress={props.onPress}>
  ${openBody}
</Pressable>
<Pressable testID="host-card-actions" onPress={props.onOpenActions} />
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
