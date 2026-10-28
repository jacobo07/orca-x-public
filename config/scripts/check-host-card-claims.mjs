import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { parse } from 'jsonc-parser'

import {
  importsOf,
  jsxOpeningTags,
  resolveSpecifier,
  stringLiterals
} from './check-workspace-surface-claims.mjs'
import { evaluateCapabilityProducers } from './host-capability-producer-gate.mjs'

/**
 * The phone's host card says only what a producer can prove (D-10).
 *
 * Two laws, enforced by what the card and its presenter DO, against config/host-card-claims.jsonc:
 *   - unreachable is not powered off: a power-loss word renders only from a power-loss state key
 *     with a producer and evidence; silence composes to unknown (D-02);
 *   - no button without a backend effect: every control carries a literal testID, is classified,
 *     and an effect control names a host RPC method that exists.
 *
 *   G1 coverage   every HOST_CARD_LABELS key is classified, in its family's model vocabulary
 *   G2 producer   path#export exists, is exported and is imported by the presenter
 *   G3 evidence   kinds from HOST_EVIDENCE_KINDS; unknown carries none, a claim carries some
 *   G4 power-loss power-loss copy only on an evidenced power-loss key, never outside the table
 *   G5 controls   literal testID, classified, navigation without effect words, effect with an RPC
 *   G6 producers  every capability id classified; supported only with evidence its producer quotes
 *                 (host-capability-producer-gate.mjs)
 *
 * Floors on labels, controls and RPC method names stop a scanner that matched nothing from
 * reporting a clean bill; a classification whose subject is gone is stale and fails.
 */

export const CONFIG_PATH = 'config/host-card-claims.jsonc'
export const MIN_LABELS = 20
export const MIN_PRESSABLES = 2
export const MIN_RPC_METHODS = 20
export const POWER_LOSS =
  /powered[\s-]?off|switched[\s-]?off|shut[\s-]?down|asleep|sleeping|hibernat|\boffline\b/i
export const EFFECT_VERB = /\b(?:wake|power[\s-]?on|turn\s+on|boot|start\s+orca)\b/i

export const VOCABULARY_NAMES = Object.freeze([
  'HOST_EVIDENCE_KINDS',
  'HOST_POWER_STATES',
  'HOST_ORCA_STATES',
  'HOST_CAPABILITY_IDS',
  'HOST_CAPABILITY_VALUES'
])
const FAMILY_VOCABULARY = Object.freeze({
  power: 'HOST_POWER_STATES',
  orca: 'HOST_ORCA_STATES',
  capability: 'HOST_CAPABILITY_IDS',
  'capability-value': 'HOST_CAPABILITY_VALUES',
  capabilities: null
})
const CONTROL_TAGS = Object.freeze([
  'Pressable',
  'TouchableOpacity',
  'TouchableHighlight',
  'Button'
])
const LABEL_BLOCK_OPENER = /export\s+const\s+HOST_CARD_LABELS\s*=\s*\{/

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length
}

/** Extent of the HOST_CARD_LABELS object literal, braces balanced, or null. */
function labelBlock(source) {
  const match = LABEL_BLOCK_OPENER.exec(source)
  if (!match) {
    return null
  }
  const start = match.index + match[0].length - 1
  let depth = 0
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') {
      depth++
    } else if (source[i] === '}' && --depth === 0) {
      return { start, end: i }
    }
  }
  return null
}

export function labelTable(presenterSource) {
  const block = labelBlock(presenterSource)
  if (!block) {
    return []
  }
  const body = presenterSource.slice(block.start, block.end)
  const rows = []
  for (const match of body.matchAll(/['"]([\w.-]+)['"]\s*:\s*(['"])((?:\\.|(?!\2)[^\\\n])*)\2/g)) {
    const key = match[1]
    const dot = key.indexOf('.')
    rows.push({
      key,
      family: dot === -1 ? key : key.slice(0, dot),
      suffix: dot === -1 ? '' : key.slice(dot + 1),
      text: match[3],
      line: lineOf(presenterSource, block.start + match.index)
    })
  }
  return rows
}

/** `name: '...'` of every defineMethod in non-test method files. */
export function rpcMethodNames(sourcesByPath) {
  const names = new Set()
  for (const [file, source] of Object.entries(sourcesByPath)) {
    if (/\.(test|spec)\.tsx?$/.test(file)) {
      continue
    }
    for (const match of source.matchAll(/define\w*Method\(\s*\{\s*name:\s*['"]([^'"]+)['"]/g)) {
      names.add(match[1])
    }
  }
  return names
}

/** The `export const NAME = [ ... ] as const` arrays of the model; an absent one is left out. */
export function modelVocabulary(modelSource) {
  const vocab = {}
  for (const name of VOCABULARY_NAMES) {
    const match = new RegExp(
      `export\\s+const\\s+${name}\\s*=\\s*\\[([^\\]]*)\\]\\s*as\\s+const`
    ).exec(modelSource)
    if (match) {
      vocab[name] = [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((item) => item[1])
    }
  }
  return vocab
}

function literalTestID(attributes) {
  const match = /\btestID\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*['"]([^'"]*)['"]\s*\})/.exec(attributes)
  return match ? (match[1] ?? match[2] ?? match[3]) : null
}

function needsWhy(entry) {
  return typeof entry?.why !== 'string' || entry.why.trim().length < 12
}

function checkCoverage({ config, table, card, cardSource, presenter, exists, vocab, failures }) {
  const labels = config.labels ?? {}
  const keys = new Set(table.map((row) => row.key))
  for (const row of table) {
    if (!labels[row.key]) {
      failures.push(
        `${presenter}:${row.line} label "${row.key}" is not classified in ${CONFIG_PATH}`
      )
    }
    if (!Object.hasOwn(FAMILY_VOCABULARY, row.family)) {
      failures.push(`label "${row.key}": family "${row.family}" is not a host card family`)
      continue
    }
    const vocabName = FAMILY_VOCABULARY[row.family]
    const allowed = vocabName === null ? ['unknown'] : vocab[vocabName]
    if (allowed && !allowed.includes(row.suffix)) {
      failures.push(
        `label "${row.key}": "${row.suffix}" is not in ${vocabName ?? 'the capabilities family (unknown only)'}`
      )
    }
  }
  for (const [key, entry] of Object.entries(labels)) {
    if (!keys.has(key)) {
      failures.push(
        `label "${key}" is classified but HOST_CARD_LABELS has no such key — stale entry`
      )
    }
    if (needsWhy(entry)) {
      failures.push(`label "${key}" needs a "why" someone can disagree with`)
    }
  }
  if (table.length < MIN_LABELS) {
    failures.push(
      `found ${table.length} host card labels, expected at least ${MIN_LABELS}; the sweep may have stopped seeing HOST_CARD_LABELS`
    )
  }
  const importsPresenter = importsOf(cardSource).some(
    (entry) =>
      entry.name === 'presentHostCardAvailability' &&
      resolveSpecifier(card, entry.specifier, exists) === presenter
  )
  if (!importsPresenter) {
    failures.push(`${card} does not import presentHostCardAvailability from ${presenter}`)
  }
}

const EXPORT_OF = (symbol) =>
  new RegExp(
    `export\\s+(?:async\\s+)?(?:function|const|let|type|interface|class|enum)\\s+${symbol}\\b`
  )
const CLAIM_FAMILIES = new Set(['power', 'orca', 'capability-value'])
const NAME_FAMILIES = new Set(['capability', 'capabilities'])
const POWER_LOSS_KEYS = Object.freeze(['power.sleeping', 'power.hibernating', 'power.powered-off'])

// Why: after these a `/` starts a regex literal; `<`, `>` and `}` are left out so JSX `</` and `} />` stay code.
const REGEX_PRECEDER = /(?:^|[(,=:[!&|?{;+\-*%~^]|\breturn|\btypeof)$/

function startsRegex(out) {
  let last = out.length - 1
  while (last >= 0 && /\s/.test(out[last])) {
    last--
  }
  return REGEX_PRECEDER.test(out.slice(Math.max(0, last - 6), last + 1))
}

/** The index just past a literal starting at `start` (quote or `/`); a newline ends a non-template one. */
function literalEnd(source, start) {
  const open = source[start]
  let inClass = false
  for (let i = start + 1; i < source.length; i++) {
    const ch = source[i]
    if (ch === '\\') {
      i++
    } else if (ch === '\n' && open !== '`') {
      return i
    } else if (open === '/' && (ch === '[' || ch === ']')) {
      inClass = ch === '['
    } else if (ch === open && !inClass) {
      return i + 1
    }
  }
  return source.length
}

/** Comments blanked to spaces outside strings and regex literals; indices and lines still match. */
export function stripComments(source) {
  let out = ''
  let i = 0
  while (i < source.length) {
    const ch = source[i]
    const next = source[i + 1]
    let end = i + 1
    if (ch === '/' && (next === '/' || next === '*')) {
      const close = next === '/' ? source.indexOf('\n', i) : source.indexOf('*/', i + 2)
      end = close === -1 ? source.length : next === '/' ? close : close + 2
      out += source.slice(i, end).replace(/[^\n]/g, ' ')
      i = end
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`' || (ch === '/' && startsRegex(out))) {
      end = literalEnd(source, i)
    }
    out += source.slice(i, end)
    i = end
  }
  return out
}

/** String literals and JSX text outside `block` (the label table), with their lines. */
function copyOutside(source, block) {
  const inside = (index) => block !== null && index > block.start && index < block.end
  const copy = stringLiterals(source).filter((literal) => !inside(literal.index))
  for (const match of source.matchAll(/>([^<>{}]+)</g)) {
    const text = match[1].trim()
    // Why: `=>` is an arrow, not the end of a JSX tag.
    if (text && source[match.index - 1] !== '=' && !inside(match.index)) {
      copy.push({ text, index: match.index, line: lineOf(source, match.index) })
    }
  }
  return copy
}

function checkModuleExport(label, role, reference, read, failures) {
  const [module, symbol] = String(reference).split('#')
  const source = read(module)
  if (source === null) {
    failures.push(`label "${label}": ${role} module ${module} does not exist`)
    return null
  }
  if (!symbol || !EXPORT_OF(symbol).test(source)) {
    failures.push(`label "${label}": ${role} ${module} does not export ${symbol}`)
    return null
  }
  return module
}

function checkProducers({ labels, presenter, presenterSource, read, exists, failures }) {
  const imported = new Set(
    importsOf(presenterSource)
      .map((entry) => resolveSpecifier(presenter, entry.specifier, exists))
      .filter(Boolean)
  )
  for (const [key, entry] of Object.entries(labels)) {
    if (typeof entry?.producer !== 'string' || !entry.producer.includes('#')) {
      failures.push(`label "${key}" has no producer "path#export"`)
    } else {
      const module = checkModuleExport(key, 'producer', entry.producer, read, failures)
      if (module !== null && !imported.has(module)) {
        failures.push(`label "${key}": producer ${module} is not imported by the presenter`)
      }
    }
    if (entry?.hostProducer !== undefined) {
      checkModuleExport(key, 'hostProducer', entry.hostProducer, read, failures)
    }
  }
}

function checkEvidence({ labels, rows, kinds, failures }) {
  for (const [key, entry] of Object.entries(labels)) {
    const evidence = entry?.evidence
    if (!Array.isArray(evidence)) {
      failures.push(`label "${key}": evidence must be a list of HOST_EVIDENCE_KINDS`)
      continue
    }
    for (const kind of Array.isArray(kinds) ? evidence : []) {
      if (!kinds.includes(kind)) {
        failures.push(`label "${key}": evidence "${kind}" is not in HOST_EVIDENCE_KINDS`)
      }
    }
    const family = key.split('.')[0]
    const suffix = key.slice(family.length + 1)
    if (NAME_FAMILIES.has(family)) {
      if (evidence.length > 0) {
        failures.push(`label "${key}" is a name and carries no evidence by itself; remove it`)
      }
    } else if (CLAIM_FAMILIES.has(family) && suffix === 'unknown') {
      if (evidence.length > 0) {
        failures.push(`label "${key}" is unknown and must carry no evidence`)
      }
      const text = rows.get(key)?.text
      if (text !== undefined && !/unknown/i.test(text)) {
        failures.push(`label "${key}" must say unknown, but reads "${text}"`)
      }
    } else if (CLAIM_FAMILIES.has(family) && evidence.length === 0) {
      failures.push(`label "${key}" claims a state but names no evidence`)
    }
  }
}

function checkPowerLoss({ labels, table, presenter, failures }) {
  for (const row of table) {
    const isLossKey = POWER_LOSS_KEYS.includes(row.key)
    if (!isLossKey && POWER_LOSS.test(row.text)) {
      failures.push(
        `${presenter}:${row.line} power-loss text "${row.text}" on "${row.key}" — only ${POWER_LOSS_KEYS.join(', ')} may say it`
      )
      continue
    }
    if (!isLossKey) {
      continue
    }
    const entry = labels[row.key]
    if (!entry?.producer) {
      failures.push(
        `power-loss label "${row.key}" has no producer — unreachable is not powered off`
      )
    }
    if (!Array.isArray(entry?.evidence) || entry.evidence.length === 0) {
      failures.push(
        `power-loss label "${row.key}" has no evidence — unreachable is not powered off`
      )
    }
  }
}

function checkAction({ card, tag, testID, action, rpcMethods, failures }) {
  if (action.kind === 'navigation') {
    if (EFFECT_VERB.test(tag.attributes)) {
      failures.push(
        `${card}:${tag.line} navigation control "${testID}" uses effect wording — a button promising what it does not do`
      )
    }
  } else if (action.kind === 'effect') {
    if (typeof action.rpc !== 'string' || !rpcMethods.has(action.rpc)) {
      failures.push(
        `action "${testID}": rpc "${action.rpc}" is not a host RPC method — an effect with no backend`
      )
    }
  } else {
    failures.push(`action "${testID}": kind "${action.kind}" is neither navigation nor effect`)
  }
}

function checkControls({ config, card, cardSource, rpcMethods, failures }) {
  const actions = config.actions ?? {}
  const seen = new Set()
  let count = 0
  for (const name of CONTROL_TAGS) {
    for (const tag of jsxOpeningTags(cardSource, name)) {
      count++
      const testID = literalTestID(tag.attributes)
      if (testID === null) {
        failures.push(
          `${card}:${tag.line} ${name} has no literal testID — a control nobody can classify`
        )
        continue
      }
      seen.add(testID)
      if (!actions[testID]) {
        failures.push(`${card}:${tag.line} control "${testID}" is not classified in ${CONFIG_PATH}`)
        continue
      }
      checkAction({ card, tag, testID, action: actions[testID], rpcMethods, failures })
    }
  }
  for (const [testID, action] of Object.entries(actions)) {
    if (!seen.has(testID)) {
      failures.push(
        `action "${testID}" is classified but the card renders no such control — stale entry`
      )
    }
    if (needsWhy(action)) {
      failures.push(`action "${testID}" needs a "why" someone can disagree with`)
    }
  }
  if (count < MIN_PRESSABLES) {
    failures.push(
      `found ${count} card controls, expected at least ${MIN_PRESSABLES}; the sweep may have stopped seeing the card`
    )
  }
  return count
}

/**
 * The whole judgement, pure: `files` maps the card and presenter paths to source, `read` returns any
 * repo file's source or null, `rpcMethods` is the scanned method-name set, `vocab` the model arrays.
 */
export function evaluateHostCardClaims({ config, files, read, rpcMethods, vocab }) {
  const failures = []
  const exists = (p) => read(p) !== null
  for (const name of VOCABULARY_NAMES) {
    if (!Array.isArray(vocab?.[name])) {
      failures.push(`vocabulary ${name} not found in ${config.model}`)
    }
  }
  const card = config.card
  const presenter = config.presenter
  const cardSource = files.get(card) ?? null
  const presenterSource = files.get(presenter) ?? null
  if (cardSource === null || presenterSource === null) {
    failures.push(`card ${card} or presenter ${presenter} does not exist`)
    return { failures, labelCount: 0, actionCount: 0, rpcCount: rpcMethods.size }
  }
  const table = labelTable(presenterSource)
  checkCoverage({
    config,
    table,
    card,
    cardSource,
    presenter,
    exists,
    vocab: vocab ?? {},
    failures
  })
  const labels = config.labels ?? {}
  const rows = new Map(table.map((row) => [row.key, row]))
  checkProducers({ labels, presenter, presenterSource, read, exists, failures })
  checkEvidence({ labels, rows, kinds: vocab?.HOST_EVIDENCE_KINDS, failures })
  checkPowerLoss({ labels, table, presenter, failures })
  const strippedCard = stripComments(cardSource)
  const actionCount = checkControls({
    config,
    card,
    cardSource: strippedCard,
    rpcMethods,
    failures
  })
  const block = labelBlock(presenterSource)
  const presenterCopy = copyOutside(stripComments(presenterSource), block)
  const cardCopy = copyOutside(strippedCard, null)
  for (const [file, copy] of [
    [card, cardCopy],
    [presenter, presenterCopy]
  ]) {
    for (const item of copy.filter((entry) => POWER_LOSS.test(entry.text))) {
      failures.push(
        `${file}:${item.line} power-loss copy "${item.text}" outside HOST_CARD_LABELS — a power state with no producer`
      )
    }
  }
  const effectBacked = Object.values(config.actions ?? {}).some(
    (action) => action?.kind === 'effect' && rpcMethods.has(action.rpc)
  )
  if (!effectBacked) {
    for (const item of cardCopy.filter((entry) => EFFECT_VERB.test(entry.text))) {
      failures.push(
        `${card}:${item.line} effect wording "${item.text}" but no effect control classified to a host RPC method`
      )
    }
  }
  if (rpcMethods.size < MIN_RPC_METHODS) {
    failures.push(
      `found ${rpcMethods.size} host RPC method names, expected at least ${MIN_RPC_METHODS}; the sweep may have stopped seeing ${config.rpcMethodsDir}`
    )
  }
  return { failures, labelCount: table.length, actionCount, rpcCount: rpcMethods.size }
}

function readRepoFile(root, relative) {
  try {
    return fs.readFileSync(path.join(root, relative), 'utf8')
  } catch {
    return null
  }
}

function methodSources(root, dir) {
  const out = {}
  let entries = []
  try {
    entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const relative = `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      Object.assign(out, methodSources(root, relative))
    } else if (entry.name.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(entry.name)) {
      out[relative] = readRepoFile(root, relative)
    }
  }
  return out
}

export async function main(root = process.cwd()) {
  const configText = readRepoFile(root, CONFIG_PATH)
  if (configText === null) {
    console.error(`check-host-card-claims: ${CONFIG_PATH} is missing`)
    return 1
  }
  const config = parse(configText)
  const files = new Map(
    [config.card, config.presenter].map((file) => [file, readRepoFile(root, file)])
  )
  const read = (relative) => files.get(relative) ?? readRepoFile(root, relative)
  const rpcMethods = rpcMethodNames(methodSources(root, config.rpcMethodsDir))
  const vocab = modelVocabulary(readRepoFile(root, config.model) ?? '')
  const result = evaluateHostCardClaims({ config, files, read, rpcMethods, vocab })
  const producers = evaluateCapabilityProducers({ config, read, vocab, stripComments })
  const failures = [...result.failures, ...producers.failures]
  if (failures.length > 0) {
    console.error(`check-host-card-claims: ${failures.length} problem(s)`)
    for (const failure of failures) {
      console.error(`  - ${failure}`)
    }
    return 1
  }
  console.log(
    `check-host-card-claims: ${result.labelCount} labels classified, ${result.actionCount} controls classified, ${result.rpcCount} host RPC methods known, no unevidenced power-loss state, no control without an effect, ${producers.producerCount} capability producers classified, ${producers.emitterCount} capability emitters scanned.`
  )
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main()
}
