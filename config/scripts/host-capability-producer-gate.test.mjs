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
      `check-host-card-claims: 22 labels classified, 2 controls classified, ${realRpcCount()} host RPC methods known, no unevidenced power-loss state, no control without an effect, 6 capability producers classified.`
    ])
  })

  it('fails a producer that emits supported while classified supported null, passes its twin', () => {
    const red = baseFixture()
    red.files['host/can-power-on-oob.ts'] = producerFile('produce', supportedBody('os-probe'))
    expect(evaluate(red).failures).toEqual([
      'capability can-power-on-oob: host/can-power-on-oob.ts#produce emits supported without an evidence producer'
    ])
    const green = baseFixture()
    expect(evaluate(green)).toEqual({ failures: [], producerCount: 6 })
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
