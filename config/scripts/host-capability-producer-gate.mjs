/**
 * G6 capability producers: no capability reads supported without a classified evidence producer (D-10).
 *
 * config/host-card-claims.jsonc `hostCapabilities` classifies every HOST_CAPABILITY_IDS member with
 *   producer   "path" (the whole file) or "path#function" (that function's region);
 *   supported  null, or { evidence: [HOST_EVIDENCE_KINDS], why } when the region may emit supported;
 *   emitters   ["path" | "path#function"], every other module that constructs the value status.get serves;
 *   why        one sentence someone can disagree with.
 *
 *   R1 section    the section exists, so deleting it cannot switch the gate off
 *   R2 coverage   every id classified, no unknown id, at least MIN_CAPABILITY_PRODUCERS entries
 *   R3 producer   the file exists and, for path#function, the region is found
 *   R4 floor      the region has a `value:` literal or constructs supported, so an emptied producer fails
 *   R5 supported  a supported value needs an allowance; every supported value carries an allowed kind beside
 *                 it, and every allowed kind is beside one (see "beside" below)
 *   R6 stale      an allowance on a region that never emits supported fails; the ratchet only tightens
 *   R7 emitters   each emitter is scanned like the producer: supported needs the same allowance and evidence
 *
 * Supported is found as `value:` or a quoted `'value':` key with a quoted or template `supported`, as a
 * constant declared `= 'supported'` in the module and flowing into `value:`, and as a shorthand `value`
 * declared so. "Beside" means the `evidence` property of the same object literal: an inline object quoting
 * the kind, or an identifier (shorthand or `evidence: name`) declared in the module with an object
 * literal quoting it; the nearest declaration before the value in the region wins, else the module's.
 * Known limits (a regex scan, not a parser): a constant imported from another module, a computed or
 * spread value, and an evidence identifier reassigned after its declaration are not followed.
 *
 * Pure: `read` returns a repo file's source or null, `stripComments` blanks comments in place.
 */

export const MIN_CAPABILITY_PRODUCERS = 6
export const SUPPORTED_LITERAL = /(?:\bvalue|(['"])value\1)\s*:\s*(['"`])supported\2/
const VALUE_LITERAL = /(?:\bvalue|(['"])value\1)\s*:\s*(['"`])[\w-]+\2/
const SUPPORTED_DECLARATION =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(['"`])supported\2/g
const STRING_LITERAL = /(['"`])(?:\\.|(?!\1)[^\\\n])*\1/g
const SECTION = 'hostCapabilities'
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

function needsWhy(entry) {
  return typeof entry?.why !== 'string' || entry.why.trim().length < 12
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** From the line declaring `function <name>(` to the first later line that is exactly `}`, or null. */
export function producerRegion(source, name) {
  if (typeof source !== 'string' || !IDENTIFIER.test(String(name))) {
    return null
  }
  const lines = source.split(/\r?\n/)
  const opener = new RegExp(
    `^(?:export\\s+)?(?:async\\s+)?function\\s+${name.replace(/\$/g, '\\$')}\\s*\\(`
  )
  const start = lines.findIndex((line) => opener.test(line))
  if (start === -1) {
    return null
  }
  const end = lines.findIndex((line, index) => index > start && line === '}')
  return end === -1 ? null : lines.slice(start, end + 1).join('\n')
}

/** Indices in `region` where a supported value is constructed, by literal, module constant or shorthand. */
export function supportedSites(region, source) {
  const sites = [...region.matchAll(new RegExp(SUPPORTED_LITERAL, 'g'))].map((m) => m.index)
  for (const [, name] of source.matchAll(SUPPORTED_DECLARATION)) {
    const use =
      name === 'value'
        ? /(?<=[{,]\s*)value(?=\s*[,}])/g
        : new RegExp(`(?:\\bvalue|(['"])value\\1)\\s*:\\s*${name.replace(/\$/g, '\\$')}\\b`, 'g')
    sites.push(...[...region.matchAll(use)].map((m) => m.index))
  }
  return sites
}

// Why masked: a brace inside a string must not move the object-literal boundaries.
function maskStrings(text) {
  return text.replace(
    STRING_LITERAL,
    (literal) => literal[0] + ' '.repeat(literal.length - 2) + literal[0]
  )
}

/** Index of the brace closing the one at `open` in masked text, or -1. */
function closingBrace(masked, open) {
  let depth = 0
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === '{') {
      depth++
    } else if (masked[i] === '}' && --depth === 0) {
      return i
    }
  }
  return -1
}

function enclosingOpenBrace(masked, index) {
  let depth = 0
  for (let i = index - 1; i >= 0; i--) {
    if (masked[i] === '}') {
      depth++
    } else if (masked[i] === '{' && depth-- === 0) {
      return i
    }
  }
  return -1
}

/** The top-level `evidence` property of the object at [open, close]: `{ open }` for an inline object, `{ name }`, or null. */
function evidenceProperty(masked, open, close) {
  let depth = 0
  for (let i = open + 1; i < close; i++) {
    const ch = masked[i]
    if ('{[('.includes(ch)) {
      depth++
    } else if ('}])'.includes(ch)) {
      depth--
    } else if (
      depth === 0 &&
      masked.startsWith('evidence', i) &&
      /[{,]\s*$/.test(masked.slice(open, i))
    ) {
      const rest = masked.slice(i + 'evidence'.length)
      const after = /^\s*(?::\s*(\{|[A-Za-z_$][\w$]*))?\s*([,}])?/.exec(rest)
      if (after[1] === '{') {
        return { open: i + 'evidence'.length + rest.indexOf('{') }
      }
      if (after[1] !== undefined) {
        return { name: after[1] }
      }
      if (after[2] !== undefined) {
        return { name: 'evidence' }
      }
    }
  }
  return null
}

/** Text of the object literal `name` is last declared with in `text` before `limit`, or null. */
function declaredObject(text, name, limit) {
  const masked = maskStrings(text)
  const declaration = new RegExp(
    `\\b(?:const|let|var)\\s+${name.replace(/\$/g, '\\$')}\\b[^=;\\n]*=\\s*\\{`,
    'g'
  )
  const found = [...masked.slice(0, limit).matchAll(declaration)].pop()
  if (found === undefined) {
    return null
  }
  const open = found.index + found[0].length - 1
  const close = closingBrace(masked, open)
  return close === -1 ? null : text.slice(open, close + 1)
}

const quotes = (kind, text) => new RegExp(`['"\`]${kind}['"\`]`).test(text)

/** The allowed kinds quoted beside the supported value at `site`. */
function kindsBeside({ region, source, site, allowed }) {
  const masked = maskStrings(region)
  const open = enclosingOpenBrace(masked, site)
  const close = open === -1 ? -1 : closingBrace(masked, open)
  const property = close === -1 ? null : evidenceProperty(masked, open, close)
  let text = null
  if (property?.open !== undefined) {
    const end = closingBrace(masked, property.open)
    text = end === -1 ? null : region.slice(property.open, end + 1)
  } else if (property?.name !== undefined && property.name !== 'null') {
    text =
      declaredObject(region, property.name, site) ??
      declaredObject(source, property.name, source.length)
  }
  return text === null ? [] : allowed.filter((kind) => quotes(kind, text))
}

/** R5/R7 "beside": each supported value carries an allowed kind, and each allowed kind backs one. */
function checkBeside({ id, label, region, source, allowed, failures }) {
  const backed = new Set()
  let unbacked = false
  for (const site of supportedSites(region, source)) {
    const kinds = kindsBeside({ region, source, site, allowed })
    kinds.forEach((kind) => backed.add(kind))
    const failure = `capability ${id}: a supported value in ${label} has no "${allowed.join('" or "')}" evidence beside it`
    if (kinds.length === 0 && !failures.includes(failure)) {
      failures.push(failure)
      unbacked = true
    }
  }
  for (const kind of unbacked ? [] : allowed.filter((kind) => !backed.has(kind))) {
    failures.push(
      `capability ${id}: supported evidence "${kind}" is never quoted beside a supported value in ${label}`
    )
  }
}

function checkCoverage(section, ids, failures) {
  if (!Array.isArray(ids)) {
    failures.push('vocabulary HOST_CAPABILITY_IDS not found; G6 cannot check capability coverage')
    return
  }
  for (const id of ids) {
    if (!Object.hasOwn(section, id)) {
      failures.push(`capability ${id} is not classified in ${SECTION}`)
    }
  }
  for (const id of Object.keys(section)) {
    if (!ids.includes(id)) {
      failures.push(
        `capability ${id} is classified in ${SECTION} but is not in HOST_CAPABILITY_IDS`
      )
    }
  }
  const count = Object.keys(section).length
  if (count < MIN_CAPABILITY_PRODUCERS) {
    failures.push(
      `found ${count} classified capability producers, expected at least ${MIN_CAPABILITY_PRODUCERS}; the classification may have been emptied`
    )
  }
}

/** The comment-stripped producer region and its whole module, or null after naming the failure. */
function resolveRegion({ id, producer, read, stripComments, failures }) {
  const [module, name] = producer.split('#')
  const original = read(module)
  if (original === null) {
    failures.push(`capability ${id}: producer module ${module} does not exist`)
    return null
  }
  const source = stripComments(original)
  if (name === undefined) {
    return { region: source, source }
  }
  const region = producerRegion(source, name)
  if (region === null) {
    failures.push(
      `capability ${id}: ${module} has no function ${name} closed by a column-0 "}" line`
    )
    return null
  }
  return { region, source }
}

function checkEvidence({ id, producer, resolved, supported, kinds, failures }) {
  const evidence = supported.evidence
  if (!Array.isArray(evidence) || evidence.length === 0) {
    failures.push(
      `capability ${id}: supported evidence must be a non-empty list of HOST_EVIDENCE_KINDS`
    )
    return
  }
  const allowed = evidence.filter((kind) => Array.isArray(kinds) && kinds.includes(kind))
  for (const kind of evidence.filter((kind) => !allowed.includes(kind))) {
    failures.push(`capability ${id}: supported evidence "${kind}" is not in HOST_EVIDENCE_KINDS`)
  }
  if (allowed.length > 0) {
    checkBeside({ id, label: producer, ...resolved, allowed, failures })
  }
  if (needsWhy(supported)) {
    failures.push(
      `capability ${id}: the supported allowance needs a "why" someone can disagree with`
    )
  }
}

function checkSupported({ id, producer, resolved, supported, kinds, failures }) {
  if (supported !== null && !isObject(supported)) {
    failures.push(`capability ${id}: supported must be null or an { evidence, why } allowance`)
    return
  }
  const emits = supportedSites(resolved.region, resolved.source).length > 0
  if (emits && supported === null) {
    failures.push(`capability ${id}: ${producer} emits supported without an evidence producer`)
  } else if (emits) {
    checkEvidence({ id, producer, resolved, supported, kinds, failures })
  } else if (supported !== null) {
    failures.push(`capability ${id}: stale supported allowance — ${producer} never emits supported`)
  }
}

/** Returns true when the producer region resolved. */
function checkEntry({ id, entry, read, kinds, stripComments, failures }) {
  if (!isObject(entry) || typeof entry.producer !== 'string' || entry.producer === '') {
    failures.push(`capability ${id} has no producer "path" or "path#function"`)
    return false
  }
  if (needsWhy(entry)) {
    failures.push(`capability ${id} needs a "why" someone can disagree with`)
  }
  const producer = entry.producer
  const resolved = resolveRegion({ id, producer, read, stripComments, failures })
  if (resolved === null) {
    return false
  }
  const constructsSupported = supportedSites(resolved.region, resolved.source).length > 0
  if (!VALUE_LITERAL.test(resolved.region) && !constructsSupported) {
    failures.push(`capability ${id}: ${producer} returns no value: literal — a vacuous producer`)
  }
  // Why no default: an absent key is not a decision, so it fails like any other malformed allowance.
  checkSupported({ id, producer, resolved, supported: entry.supported, kinds, failures })
  return true
}

/** R7: the count of emitter regions that resolved; a probe wrapper may not emit what its verdict cannot. */
function checkEmitters({ id, entry, read, kinds, stripComments, failures }) {
  const emitters = entry.emitters
  const malformed = (emitter) => typeof emitter !== 'string' || emitter === ''
  if (!Array.isArray(emitters) || emitters.some(malformed)) {
    failures.push(
      `capability ${id}: emitters must list the "path" or "path#function" modules that construct its value`
    )
    return 0
  }
  let scanned = 0
  for (const emitter of emitters) {
    const resolved = resolveRegion({ id, producer: emitter, read, stripComments, failures })
    if (resolved === null) {
      continue
    }
    scanned++
    if (supportedSites(resolved.region, resolved.source).length === 0) {
      continue
    }
    if (entry.supported === null) {
      failures.push(
        `capability ${id}: emitter ${emitter} emits supported without an evidence producer`
      )
    } else if (isObject(entry.supported) && Array.isArray(entry.supported.evidence)) {
      const allowed = entry.supported.evidence.filter(
        (kind) => Array.isArray(kinds) && kinds.includes(kind)
      )
      if (allowed.length > 0) {
        checkBeside({ id, label: `emitter ${emitter}`, ...resolved, allowed, failures })
      }
    }
  }
  return scanned
}

/** The whole G6 judgement over `config.hostCapabilities`; `producerCount` and `emitterCount` count resolved regions. */
export function evaluateCapabilityProducers({ config, read, vocab, stripComments }) {
  const failures = []
  const section = config?.[SECTION]
  if (!isObject(section)) {
    failures.push(
      `config has no ${SECTION} section; every HOST_CAPABILITY_IDS member must be classified (G6)`
    )
    return { failures, producerCount: 0, emitterCount: 0 }
  }
  checkCoverage(section, vocab?.HOST_CAPABILITY_IDS, failures)
  let producerCount = 0
  let emitterCount = 0
  for (const [id, entry] of Object.entries(section)) {
    const kinds = vocab?.HOST_EVIDENCE_KINDS
    if (checkEntry({ id, entry, read, kinds, stripComments, failures })) {
      producerCount++
    }
    if (isObject(entry)) {
      emitterCount += checkEmitters({ id, entry, read, kinds, stripComments, failures })
    }
  }
  return { failures, producerCount, emitterCount }
}
