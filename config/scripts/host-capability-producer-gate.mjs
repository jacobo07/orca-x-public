/**
 * G6 capability producers: no capability reads supported without a classified evidence producer (D-10).
 *
 * config/host-card-claims.jsonc `hostCapabilities` classifies every HOST_CAPABILITY_IDS member with
 *   producer   "path" (the whole file) or "path#function" (that function's region);
 *   supported  null, or { evidence: [HOST_EVIDENCE_KINDS], why } when the region may emit supported;
 *   why        one sentence someone can disagree with.
 *
 *   R1 section    the section exists, so deleting it cannot switch the gate off
 *   R2 coverage   every id classified, no unknown id, at least MIN_CAPABILITY_PRODUCERS entries
 *   R3 producer   the file exists and, for path#function, the region is found
 *   R4 floor      the region returns at least one `value:` literal, so an emptied producer fails
 *   R5 supported  a supported literal needs an allowance whose evidence kinds are quoted in the region
 *   R6 stale      an allowance on a region that never emits supported fails; the ratchet only tightens
 *
 * Pure: `read` returns a repo file's source or null, `stripComments` blanks comments in place.
 */

export const MIN_CAPABILITY_PRODUCERS = 6
export const SUPPORTED_LITERAL = /value:\s*['"]supported['"]/
const VALUE_LITERAL = /\bvalue:\s*['"][\w-]+['"]/
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

/** The comment-stripped producer region for `entry.producer`, or null after naming the failure. */
function resolveRegion({ id, producer, read, stripComments, failures }) {
  const [module, name] = producer.split('#')
  const source = read(module)
  if (source === null) {
    failures.push(`capability ${id}: producer module ${module} does not exist`)
    return null
  }
  const stripped = stripComments(source)
  if (name === undefined) {
    return stripped
  }
  const region = producerRegion(stripped, name)
  if (region === null) {
    failures.push(
      `capability ${id}: ${module} has no function ${name} closed by a column-0 "}" line`
    )
  }
  return region
}

function checkEvidence({ id, producer, region, supported, kinds, failures }) {
  const evidence = supported.evidence
  if (!Array.isArray(evidence) || evidence.length === 0) {
    failures.push(
      `capability ${id}: supported evidence must be a non-empty list of HOST_EVIDENCE_KINDS`
    )
    return
  }
  for (const kind of evidence) {
    if (!Array.isArray(kinds) || !kinds.includes(kind)) {
      failures.push(`capability ${id}: supported evidence "${kind}" is not in HOST_EVIDENCE_KINDS`)
    } else if (!new RegExp(`['"]${kind}['"]`).test(region)) {
      failures.push(`capability ${id}: supported evidence "${kind}" is never quoted in ${producer}`)
    }
  }
  if (needsWhy(supported)) {
    failures.push(
      `capability ${id}: the supported allowance needs a "why" someone can disagree with`
    )
  }
}

function checkSupported({ id, producer, region, supported, kinds, failures }) {
  if (supported !== null && !isObject(supported)) {
    failures.push(`capability ${id}: supported must be null or an { evidence, why } allowance`)
    return
  }
  const emits = SUPPORTED_LITERAL.test(region)
  if (emits && supported === null) {
    failures.push(`capability ${id}: ${producer} emits supported without an evidence producer`)
  } else if (emits) {
    checkEvidence({ id, producer, region, supported, kinds, failures })
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
  const region = resolveRegion({ id, producer, read, stripComments, failures })
  if (region === null) {
    return false
  }
  if (!VALUE_LITERAL.test(region)) {
    failures.push(`capability ${id}: ${producer} returns no value: literal — a vacuous producer`)
  }
  // Why no default: an absent key is not a decision, so it fails like any other malformed allowance.
  checkSupported({ id, producer, region, supported: entry.supported, kinds, failures })
  return true
}

/** The whole G6 judgement over `config.hostCapabilities`; `producerCount` counts resolved regions. */
export function evaluateCapabilityProducers({ config, read, vocab, stripComments }) {
  const failures = []
  const section = config?.[SECTION]
  if (!isObject(section)) {
    failures.push(
      `config has no ${SECTION} section; every HOST_CAPABILITY_IDS member must be classified (G6)`
    )
    return { failures, producerCount: 0 }
  }
  checkCoverage(section, vocab?.HOST_CAPABILITY_IDS, failures)
  let producerCount = 0
  for (const [id, entry] of Object.entries(section)) {
    const kinds = vocab?.HOST_EVIDENCE_KINDS
    if (checkEntry({ id, entry, read, kinds, stripComments, failures })) {
      producerCount++
    }
  }
  return { failures, producerCount }
}
