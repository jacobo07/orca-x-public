import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse } from 'jsonc-parser'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CONFIG_PATH, main, rpcMethodNames, stripComments } from './check-host-card-claims.mjs'
import { evaluateCapabilityProducers } from './host-capability-producer-gate.mjs'

// Synthetic producers, one file per id, except the real-repo row: every red case has a green twin.

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

const VOCAB = {
  HOST_EVIDENCE_KINDS: ['live-response', 'host-announced', 'relay-reported', 'os-probe'],
  HOST_CAPABILITY_IDS: [
    'can-start-orca',
    'can-wake-lan',
    'can-wake-remote',
    'can-power-on-oob',
    'can-relay',
    'can-direct'
  ]
}

const UNKNOWN_BODY = "  return { value: 'unknown', reason: 'unobserved', evidence: null }"

function supportedBody(kind, quote = "'") {
  return `  return { value: ${quote}supported${quote}, reason: 'seen', evidence: { kind: '${kind}', observedAt: nowMs } }`
}

function producerFile(name, body = UNKNOWN_BODY) {
  return `export function ${name}(nowMs) {\n${body}\n}\n`
}

function baseFixture() {
  const files = {}
  const section = {}
  for (const id of VOCAB.HOST_CAPABILITY_IDS) {
    const file = `host/${id}.ts`
    files[file] = producerFile('produce')
    section[id] = {
      producer: `${file}#produce`,
      supported: null,
      emitters: [],
      why: 'a synthetic producer that never claims supported'
    }
  }
  return { files, section }
}

function evaluate({ files, section }) {
  const config = section === undefined ? {} : { hostCapabilities: section }
  return evaluateCapabilityProducers({
    config,
    read: (relative) => files[relative] ?? null,
    vocab: VOCAB,
    stripComments
  })
}

function realRpcCount() {
  const config = parse(fs.readFileSync(path.join(REPO_ROOT, CONFIG_PATH), 'utf8'))
  const sources = {}
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
      const relative = `${dir}/${entry.name}`
      if (entry.isDirectory()) {
        walk(relative)
      } else if (entry.name.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(entry.name)) {
        sources[relative] = fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8')
      }
    }
  }
  walk(config.rpcMethodsDir)
  return rpcMethodNames(sources).size
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('G6 capability producers', () => {
  it('passes on the real repo with the exact success line naming six classified producers', async () => {
    const logged = []
    const errors = []
    vi.spyOn(console, 'log').mockImplementation((line) => logged.push(line))
    vi.spyOn(console, 'error').mockImplementation((line) => errors.push(line))
    const code = await main(REPO_ROOT)
    expect(errors).toEqual([])
    expect(code).toBe(0)
    expect(logged).toEqual([
      `check-host-card-claims: 22 labels classified, 2 controls classified, ${realRpcCount()} host RPC methods known, no unevidenced power-loss state, no control without an effect, 6 capability producers classified, 3 capability emitters scanned.`
    ])
  })

  it('fails a producer that emits supported while classified supported null, passes its twin', () => {
    const red = baseFixture()
    red.files['host/can-power-on-oob.ts'] = producerFile('produce', supportedBody('os-probe'))
    expect(evaluate(red).failures).toEqual([
      'capability can-power-on-oob: host/can-power-on-oob.ts#produce emits supported without an evidence producer'
    ])
    const green = baseFixture()
    expect(evaluate(green)).toEqual({ failures: [], producerCount: 6, emitterCount: 0 })
  })

  it('fails when the hostCapabilities section is missing, so deleting it cannot disable G6', () => {
    const { files } = baseFixture()
    const result = evaluate({ files, section: undefined })
    expect(result.failures).toEqual([
      'config has no hostCapabilities section; every HOST_CAPABILITY_IDS member must be classified (G6)'
    ])
    expect(result.producerCount).toBe(0)
  })
})

function allowance(evidence) {
  return { evidence, why: 'a synthetic allowance backed by the quoted kind' }
}

function withProducer(id, body, supported = null) {
  const fixture = baseFixture()
  fixture.files[`host/${id}.ts`] = producerFile('produce', body)
  fixture.section[id] = { ...fixture.section[id], supported }
  return fixture
}

const PASS = { failures: [], producerCount: 6, emitterCount: 0 }

describe('G6 rule table', () => {
  it('R2: fails when an id is missing, passes when it is classified', () => {
    const red = baseFixture()
    delete red.section['can-direct']
    expect(evaluate(red).failures).toContain(
      'capability can-direct is not classified in hostCapabilities'
    )
    expect(evaluate(baseFixture())).toEqual(PASS)
  })

  it('R2: fails an extra id that is not in HOST_CAPABILITY_IDS', () => {
    const red = baseFixture()
    red.files['host/can-teleport.ts'] = producerFile('produce')
    red.section['can-teleport'] = {
      ...red.section['can-relay'],
      producer: 'host/can-teleport.ts#produce'
    }
    expect(evaluate(red).failures).toEqual([
      'capability can-teleport is classified in hostCapabilities but is not in HOST_CAPABILITY_IDS'
    ])
  })

  it('R2: fails below the floor of six classified producers even when coverage holds', () => {
    const fiveIds = VOCAB.HOST_CAPABILITY_IDS.slice(0, 5)
    const red = baseFixture()
    delete red.section['can-direct']
    const result = evaluateCapabilityProducers({
      config: { hostCapabilities: red.section },
      read: (relative) => red.files[relative] ?? null,
      vocab: { ...VOCAB, HOST_CAPABILITY_IDS: fiveIds },
      stripComments
    })
    expect(result.failures).toEqual([
      'found 5 classified capability producers, expected at least 6; the classification may have been emptied'
    ])
  })

  it('R3: fails when the producer file does not exist', () => {
    const red = baseFixture()
    red.section['can-relay'].producer = 'host/missing.ts#produce'
    expect(evaluate(red)).toEqual({
      failures: ['capability can-relay: producer module host/missing.ts does not exist'],
      producerCount: 5,
      emitterCount: 0
    })
  })

  it('R3: fails when the named function does not exist in the producer file', () => {
    const red = baseFixture()
    red.section['can-relay'].producer = 'host/can-relay.ts#renamedAway'
    expect(evaluate(red).failures).toEqual([
      'capability can-relay: host/can-relay.ts has no function renamedAway closed by a column-0 "}" line'
    ])
  })

  it('R3: fails a function declared without a closing column-0 line', () => {
    const red = baseFixture()
    red.files['host/can-relay.ts'] = `export function produce(nowMs) {\n${UNKNOWN_BODY}\n  }\n`
    expect(evaluate(red).failures).toEqual([
      'capability can-relay: host/can-relay.ts has no function produce closed by a column-0 "}" line'
    ])
  })

  it('R4: fails a region with no value literal, passes the same region with one', () => {
    const red = withProducer('can-wake-lan', '  return computeElsewhere(nowMs)')
    expect(evaluate(red).failures).toEqual([
      'capability can-wake-lan: host/can-wake-lan.ts#produce returns no value: literal — a vacuous producer'
    ])
    const green = withProducer(
      'can-wake-lan',
      `  const ignored = computeElsewhere(nowMs)\n${UNKNOWN_BODY}`
    )
    expect(evaluate(green)).toEqual(PASS)
  })

  it('R5: fails supported evidence that is not a HOST_EVIDENCE_KINDS member', () => {
    const red = withProducer('can-relay', supportedBody('made-up'), allowance(['made-up']))
    expect(evaluate(red).failures).toEqual([
      'capability can-relay: supported evidence "made-up" is not in HOST_EVIDENCE_KINDS'
    ])
  })

  it('R5: fails evidence the region never quotes, passes the kind it does quote', () => {
    const red = withProducer('can-relay', supportedBody('relay-reported'), allowance(['os-probe']))
    expect(evaluate(red).failures).toEqual([
      'capability can-relay: supported evidence "os-probe" is never quoted in host/can-relay.ts#produce'
    ])
    const green = withProducer(
      'can-relay',
      supportedBody('relay-reported'),
      allowance(['relay-reported'])
    )
    expect(evaluate(green)).toEqual(PASS)
  })

  it('R5: fails an empty evidence list', () => {
    const red = withProducer('can-relay', supportedBody('relay-reported'), allowance([]))
    expect(evaluate(red).failures).toEqual([
      'capability can-relay: supported evidence must be a non-empty list of HOST_EVIDENCE_KINDS'
    ])
  })

  it('R5: detects a double-quoted supported value', () => {
    const red = withProducer('can-wake-remote', supportedBody('host-announced', '"'))
    expect(evaluate(red).failures).toEqual([
      'capability can-wake-remote: host/can-wake-remote.ts#produce emits supported without an evidence producer'
    ])
  })

  it('R5: scans per region, not per file, when two producers share a file', () => {
    const shared = [
      producerFile('emitsSupported', supportedBody('relay-reported')),
      producerFile('neverSupported')
    ].join('\n')
    const fixture = (relaySupported) => {
      const base = baseFixture()
      base.files['host/shared.ts'] = shared
      base.section['can-relay'] = {
        ...base.section['can-relay'],
        producer: 'host/shared.ts#emitsSupported',
        supported: relaySupported
      }
      base.section['can-direct'] = {
        ...base.section['can-direct'],
        producer: 'host/shared.ts#neverSupported'
      }
      return base
    }
    expect(evaluate(fixture(allowance(['relay-reported'])))).toEqual(PASS)
    expect(evaluate(fixture(null)).failures).toEqual([
      'capability can-relay: host/shared.ts#emitsSupported emits supported without an evidence producer'
    ])
  })

  it('R6: fails a supported allowance on a region that never emits supported', () => {
    const red = withProducer('can-direct', UNKNOWN_BODY, allowance(['host-announced']))
    expect(evaluate(red).failures).toEqual([
      'capability can-direct: stale supported allowance — host/can-direct.ts#produce never emits supported'
    ])
  })

  it('fails an entry that omits the supported key instead of reading it as null', () => {
    const red = baseFixture()
    delete red.section['can-wake-lan'].supported
    expect(evaluate(red).failures).toEqual([
      'capability can-wake-lan: supported must be null or an { evidence, why } allowance'
    ])
  })

  it('ignores a supported literal inside line and block comments, catches it uncommented', () => {
    const commented = [
      "  // return { value: 'supported', evidence: { kind: 'os-probe' } }",
      "  /* value: 'supported' */",
      UNKNOWN_BODY
    ].join('\n')
    expect(evaluate(withProducer('can-power-on-oob', commented))).toEqual(PASS)
    expect(evaluate(withProducer('can-power-on-oob', supportedBody('os-probe'))).failures).toEqual([
      'capability can-power-on-oob: host/can-power-on-oob.ts#produce emits supported without an evidence producer'
    ])
  })
})

// A probe wrapper constructs values the verdict never sees, so it is scanned like the producer (WR-01).
function withEmitter(id, body, supported = null) {
  const fixture = baseFixture()
  fixture.files['host/probe.ts'] = producerFile('readPlatform', body)
  fixture.section[id] = { ...fixture.section[id], supported, emitters: ['host/probe.ts'] }
  return fixture
}

describe('G6 R7 emitters', () => {
  it('fails a supported literal planted in a probe module, passes the same probe without it', () => {
    for (const id of ['can-wake-lan', 'can-wake-remote', 'can-power-on-oob']) {
      expect(evaluate(withEmitter(id, supportedBody('os-probe'))).failures, id).toEqual([
        `capability ${id}: emitter host/probe.ts emits supported without an evidence producer`
      ])
      expect(evaluate(withEmitter(id, UNKNOWN_BODY)), id).toEqual({ ...PASS, emitterCount: 1 })
    }
  })

  it('lets an emitter of an allowed capability quote the allowance evidence, fails one that does not', () => {
    const producer = supportedBody('os-probe')
    const green = withEmitter('can-start-orca', producer, allowance(['os-probe']))
    green.files['host/can-start-orca.ts'] = producerFile('produce', producer)
    expect(evaluate(green)).toEqual({ ...PASS, emitterCount: 1 })
    const red = withEmitter(
      'can-start-orca',
      supportedBody('host-announced'),
      allowance(['os-probe'])
    )
    red.files['host/can-start-orca.ts'] = producerFile('produce', producer)
    expect(evaluate(red).failures).toEqual([
      'capability can-start-orca: supported evidence "os-probe" is never quoted in emitter host/probe.ts'
    ])
  })

  it('fails an entry that omits emitters, and an emitter module that does not exist', () => {
    const absent = baseFixture()
    delete absent.section['can-power-on-oob'].emitters
    expect(evaluate(absent).failures).toEqual([
      'capability can-power-on-oob: emitters must list the "path" or "path#function" modules that construct its value'
    ])
    const missing = baseFixture()
    missing.section['can-power-on-oob'].emitters = ['host/gone.ts']
    expect(evaluate(missing)).toEqual({
      failures: ['capability can-power-on-oob: producer module host/gone.ts does not exist'],
      producerCount: 6,
      emitterCount: 0
    })
  })
})
