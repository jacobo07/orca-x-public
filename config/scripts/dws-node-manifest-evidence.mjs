// Pure evidence tooling for the one-node manifest (05-05): judge a product reading against an
// independent ssh control reading, assemble the evidence file, and refuse anything carrying a secret.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const MIB = 1024 * 1024
const GIB = 1024 * MIB

// Why: the control reading is taken seconds after the product reading on a shared machine, so exact equality would be a false DIVERGED.
export const TOLERANCES = {
  memoryAvailableFraction: {
    value: 0.1,
    reason: 'available memory drifts with page cache between two readings seconds apart'
  },
  memoryAvailableMinBytes: {
    value: 512 * MIB,
    reason: 'floor for the fractional tolerance so a small host is not held to a few MiB'
  },
  vramFreeBytes: {
    value: 256 * MIB,
    reason: 'two other tenants (llama-server, ComfyUI) allocate on the same GPU'
  },
  diskAvailableBytes: {
    value: GIB,
    reason: 'a 99%-full shared filesystem moves by hundreds of MiB per minute'
  },
  modelIds: { value: 'exact-set-equality', reason: 'a model id is either served or it is not' }
}

const FAMILIES = ['memory', 'vram', 'disk', 'resident_model']
const FAMILY_FIELD = {
  memory: 'memoryAvailableBytes',
  vram: 'vramFreeBytes',
  disk: 'diskAvailableBytes',
  resident_model: 'modelIds'
}
const SECTION_MARKER = /^CONTROL_[A-Z]+$/

function sections(text) {
  const out = {}
  let current = null
  for (const line of text.replace(/\r/g, '').split('\n')) {
    const trimmed = line.trim()
    if (SECTION_MARKER.test(trimmed)) {
      current = trimmed
      out[current] = []
    } else if (current) {
      out[current].push(line)
    }
  }
  return out
}

function nonNegativeInteger(text) {
  return /^\d+$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : null
}

function parseFreeAvailable(lines) {
  const header = lines.find((line) => /\bavailable\b/.test(line))
  const mem = lines.find((line) => line.startsWith('Mem:'))
  if (!header || !mem) {
    return null
  }
  // Why: `free` prints the header without the "Mem:" label, so its column i is the row's token i + 1.
  const column = header.trim().split(/\s+/).indexOf('available')
  return column < 0 ? null : nonNegativeInteger(mem.trim().split(/\s+/)[column + 1] ?? '')
}

function parseMaxGpuFree(lines) {
  const rows = lines.filter((line) => line.trim() !== '')
  let best = null
  for (const row of rows) {
    const columns = row.split(',').map((column) => column.trim())
    const total = nonNegativeInteger(columns[1] ?? '')
    const free = nonNegativeInteger(columns[3] ?? '')
    if (columns.length !== 4 || total === null || free === null || free > total) {
      return null
    }
    best = Math.max(best ?? 0, free * MIB)
  }
  return best
}

function parseDfAvailable(lines) {
  const at = lines.findIndex((line) => /\bAvailable\b/.test(line))
  // Why: a long device name makes df wrap the row, so join every token after the header.
  const tokens = lines
    .slice(at + 1)
    .join(' ')
    .trim()
    .split(/\s+/)
  return at < 0 ? null : nonNegativeInteger(tokens[3] ?? '')
}

function parseModelIds(lines) {
  try {
    const data = JSON.parse(lines.join('\n')).data
    const ids = Array.isArray(data) ? data.map((entry) => entry?.id) : null
    return ids && ids.length > 0 && ids.every((id) => typeof id === 'string' && id !== '')
      ? ids
      : null
  } catch {
    return null
  }
}

export function parseControlOutput(text) {
  const empty = {
    valid: false,
    memoryAvailableBytes: null,
    vramFreeBytes: null,
    diskAvailableBytes: null,
    modelIds: null
  }
  const first = text
    .replace(/\r/g, '')
    .split('\n')
    .find((line) => line.trim() !== '')
  // Why: a rewritten command must read as harness failure, not as a measurement (05-RESEARCH Q6 note).
  if (first?.trim() !== 'CONTROL_BEGIN') {
    return { ...empty, unjudgedReason: 'harness-rewrote-command' }
  }
  const parts = sections(text)
  return {
    valid: true,
    memoryAvailableBytes: parseFreeAvailable(parts.CONTROL_FREE ?? []),
    vramFreeBytes: parseMaxGpuFree(parts.CONTROL_NVIDIA ?? []),
    diskAvailableBytes: parseDfAvailable(parts.CONTROL_DF ?? []),
    modelIds: parseModelIds(parts.CONTROL_MODELS ?? [])
  }
}

function sameSet(left, right) {
  return (
    left.length === right.length &&
    new Set(left).size === new Set(right).size &&
    left.every((id) => right.includes(id))
  )
}

function numericEntry(product, control, tolerance) {
  const delta = Math.abs(product - control)
  return { verdict: delta <= tolerance ? 'MATCH' : 'DIVERGED', delta, tolerance }
}

function judgeFamily(family, product, control, controlReason) {
  const field = FAMILY_FIELD[family]
  const productValue = product[field] ?? null
  const controlValue = control[field] ?? null
  if (productValue === null && controlValue === null) {
    return { verdict: 'UNJUDGED', reason: 'both-unknown' }
  }
  if (productValue === null) {
    return { verdict: 'UNJUDGED', reason: 'product-unknown' }
  }
  if (controlValue === null) {
    return { verdict: 'UNJUDGED', reason: controlReason }
  }
  if (family === 'resident_model') {
    return sameSet(productValue, controlValue)
      ? { verdict: 'MATCH', tolerance: TOLERANCES.modelIds.value }
      : { verdict: 'DIVERGED', tolerance: TOLERANCES.modelIds.value }
  }
  const tolerance =
    family === 'memory'
      ? Math.max(
          TOLERANCES.memoryAvailableFraction.value * controlValue,
          TOLERANCES.memoryAvailableMinBytes.value
        )
      : family === 'vram'
        ? TOLERANCES.vramFreeBytes.value
        : TOLERANCES.diskAvailableBytes.value
  return numericEntry(productValue, controlValue, tolerance)
}

export function compareReadings(product, control) {
  // Why: a reference compared with itself proves nothing, so it is refused rather than reported as MATCH.
  if (product === control) {
    return Object.fromEntries(
      FAMILIES.map((family) => [family, { verdict: 'UNJUDGED', reason: 'same-operand' }])
    )
  }
  const controlReason = control?.unjudgedReason ?? 'control-missing'
  return Object.fromEntries(
    FAMILIES.map((family) => [
      family,
      judgeFamily(family, product ?? {}, control ?? {}, controlReason)
    ])
  )
}

const SECRET_RULES = [
  ['pairing-url', /orca:\/\/pair/i],
  ['code-query', /\?code=/i],
  ['token-run', /(?:token|bearer)\W{0,10}[A-Za-z0-9+/_-]{64,}={0,2}/i],
  ['token-run', /[A-Za-z0-9+/_-]{64,}={0,2}\W{0,10}(?:token|bearer)/i],
  ['agent-home', /\/home\/kobii\/\.(?:claude|codex)/]
]

export function scanForSecrets(text) {
  return SECRET_RULES.filter(([, pattern]) => pattern.test(text)).map(([rule]) => rule)
}

function requireText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`evidence refused: ${name} is missing`)
  }
}

export function buildEvidence(input) {
  requireText(input.headSha, 'headSha')
  const deployed = input.deployed ?? {}
  const blocked = input.rung === 'none'
  if (!blocked) {
    requireText(deployed.sha, 'deployed.sha')
    requireText(deployed.artifactSha256Laptop, 'deployed.artifactSha256Laptop')
    requireText(deployed.artifactSha256Gex44, 'deployed.artifactSha256Gex44')
  }
  if (
    deployed.artifactSha256Laptop !== undefined &&
    deployed.artifactSha256Gex44 !== undefined &&
    deployed.artifactSha256Laptop !== deployed.artifactSha256Gex44
  ) {
    throw new Error('evidence refused: artifact sha256 differs between laptop and GEX44')
  }
  if (blocked) {
    requireText(input.rungReached, 'rungReached')
    requireText(input.blockedReason, 'blockedReason')
  }
  const comparison = blocked
    ? Object.fromEntries(
        FAMILIES.map((family) => [family, { verdict: 'UNJUDGED', reason: 'blocked' }])
      )
    : compareReadings(input.product, input.control)
  // Why: GEX44-PROVEN is claimed only for values the product actually measured this run.
  const planeTags = blocked
    ? {}
    : Object.fromEntries(
        FAMILIES.filter((family) => (input.product?.[FAMILY_FIELD[family]] ?? null) !== null).map(
          (family) => [family, 'GEX44-PROVEN']
        )
      )
  const evidence = {
    verdict: blocked ? 'BLOCKED' : 'MEASURED',
    rung: input.rung,
    ...(blocked ? { rungReached: input.rungReached, blockedReason: input.blockedReason } : {}),
    headSha: input.headSha,
    runtimeIdMatchesServe: input.runtimeIdMatchesServe ?? null,
    deployed: input.deployed ?? null,
    utc: input.utc ?? null,
    product: blocked ? null : (input.product ?? null),
    control: blocked ? null : (input.control ?? null),
    comparison,
    planeTags,
    notes: input.notes ?? []
  }
  const found = scanForSecrets(JSON.stringify(evidence))
  if (found.length > 0) {
    throw new Error(`evidence refused: secret pattern(s) found: ${[...new Set(found)].join(', ')}`)
  }
  return evidence
}

// Usage: node dws-node-manifest-evidence.mjs <input.json> <control-output.txt> <out.json>
function main(argv) {
  const [inputPath, controlPath, outPath] = argv
  const input = JSON.parse(readFileSync(inputPath, 'utf8'))
  const control =
    controlPath && input.rung !== 'none'
      ? parseControlOutput(readFileSync(controlPath, 'utf8'))
      : null
  writeFileSync(outPath, `${JSON.stringify(buildEvidence({ ...input, control }), null, 2)}\n`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2))
}
