// Turns the 05-05 run record into docs/dws/phase-5-node-manifest.{json,md}; refuses any secret-shaped text.
// Usage: node dws-node-manifest-evidence-write.mjs <run-record.json> <out.json> <out.md> <evidence-module.mjs>
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const [recordPath, outJson, outMd, evidenceModule] = process.argv.slice(2)
const ev = await import(pathToFileURL(evidenceModule).href)
const rec = JSON.parse(readFileSync(recordPath, 'utf8'))
const FAMILIES = ['memory', 'vram', 'disk', 'resident_model']
const FIELD = {
  memory: 'memoryAvailableBytes',
  vram: 'vramFreeBytes',
  disk: 'diskAvailableBytes',
  resident_model: 'modelIds'
}

function readText(path) {
  return path ? readFileSync(path, 'utf8') : null
}

function measuredValue(measurement) {
  return measurement?.status === 'measured' ? measurement.value : null
}

// Why: the disk family is judged against the control's df of `/`, so the product's `/` entry is the like-for-like one.
function productFrom(manifestText, serveRuntimeId) {
  const parsed = JSON.parse(manifestText)
  const envelope = parsed.result ?? parsed
  if (envelope.status !== 'ok' || !Array.isArray(envelope.manifests)) {
    return { error: `manifest result status=${envelope.status ?? 'missing'}` }
  }
  const member = envelope.manifests.find((m) => m.node?.runtime_id === serveRuntimeId)
  if (!member) {
    return { error: 'no manifest member carries the deployed serve runtime id' }
  }
  const { memory, vram, disk, resident_model: model } = member.measurements
  const gpus = measuredValue(vram)?.gpus
  const filesystems = measuredValue(disk)?.filesystems
  const root = filesystems?.find((fs) => fs.path === '/') ?? filesystems?.[0]
  const endpoints = measuredValue(model)?.endpoints
  return {
    product: {
      memoryAvailableBytes: measuredValue(memory)?.available_bytes ?? null,
      vramFreeBytes: gpus ? Math.max(...gpus.map((g) => g.free_bytes)) : null,
      diskAvailableBytes: root?.available_bytes ?? null,
      modelIds: endpoints ? endpoints.flatMap((e) => e.model_ids) : null,
      diskFilesystemPath: root?.path ?? null,
      statuses: Object.fromEntries(
        Object.entries(member.measurements).map(([k, v]) => [k, v.status === 'unknown' ? `unknown:${v.reason}` : 'measured'])
      ),
      memberAddress: member.node.address,
      observedAt: envelope.observedAt ?? null
    }
  }
}

let blockedReason = rec.blockedReason
let rung = rec.rung
let rungReached = rec.rungReached
let product = null
let runtimeIdMatchesServe = null
const notes = []

if (rung !== 'none') {
  const built = rec.serveRuntimeId
    ? productFrom(readText(rec.productManifest), rec.serveRuntimeId)
    : { error: 'deployed serve runtime id not readable, member cannot be attributed' }
  if (built.error) {
    rung = 'none'
    blockedReason = `product-read: ${built.error}`
    rungReached = 'product-read'
  } else {
    product = built.product
    runtimeIdMatchesServe = Boolean(rec.serveRuntimeId)
  }
}

const controlBefore = readText(rec.controlBefore)
const controlAfter = readText(rec.controlAfter)
const parsedBefore = controlBefore ? ev.parseControlOutput(controlBefore) : null
const parsedAfter = controlAfter ? ev.parseControlOutput(controlAfter) : null

const evidence = ev.buildEvidence({
  headSha: rec.headSha,
  rung,
  rungReached,
  blockedReason,
  deployed: rec.deployed,
  runtimeIdMatchesServe,
  utc: { start: rec.utcStart, end: rec.utcEnd },
  product,
  control: parsedBefore,
  notes
})

if (rung !== 'none') {
  const stability = parsedAfter ? ev.compareReadings(parsedBefore, parsedAfter) : null
  evidence.controlStability = stability ?? { verdict: 'UNJUDGED', reason: 'control-after-missing' }
  for (const family of FAMILIES) {
    const moved = stability?.[family]?.verdict === 'DIVERGED'
    if (moved || !stability) {
      evidence.comparison[family] = {
        verdict: 'UNJUDGED',
        reason: moved ? 'control-unstable' : 'control-after-missing',
        productVsControl: evidence.comparison[family]
      }
    }
  }
  notes.push(`judged against control-before; product reading: ${rung}`)
}
evidence.probePort = rec.probePort
evidence.fanOut = rec.fanOut
evidence.teardown = rec.teardown
evidence.serveMainPid = { before: rec.mainPidBefore, after: rec.mainPidAfter }
evidence.laptopFreeMbAtStart = rec.laptopFreeMb
evidence.notes = notes

function diskFact() {
  const lines = (controlBefore ?? '').split('\n')
  const at = lines.findIndex((l) => /\bAvailable\b/.test(l))
  const t = at < 0 ? [] : lines.slice(at + 1).join(' ').trim().split(/\s+/)
  const [total, used, avail] = [t[1], t[2], t[3]].map(Number)
  return total > 0 ? { availableBytes: avail, percentUsed: Math.round((used / (used + avail)) * 100) } : null
}
evidence.diskFact = diskFact()

const jsonText = `${JSON.stringify(evidence, null, 2)}\n`

const gib = (n) => (typeof n === 'number' ? `${(n / 1024 ** 3).toFixed(2)} GiB` : 'n/a')
function mdRows() {
  return FAMILIES.map((f) => {
    const c = evidence.comparison[f]
    const p = product?.[FIELD[f]]
    const shown = Array.isArray(p) ? p.join(', ') : (p ?? 'n/a')
    return `| ${f} | ${c.verdict} | ${c.reason ?? ''} | ${shown} | ${evidence.planeTags[f] ?? 'none'} |`
  }).join('\n')
}

const tol = Object.entries(ev.TOLERANCES).map(([k, v]) => `- ${k} = ${typeof v.value === 'number' ? v.value : v.value}: ${v.reason}`).join('\n')
const disk = evidence.diskFact
const md = evidence.verdict === 'MEASURED'
  ? `# Phase 5 - GEX44 node manifest measurement

Verdict: MEASURED at rung \`${rung}\` on ${rec.utcStart} .. ${rec.utcEnd}, HEAD ${rec.headSha}.
Artifact sha256 (laptop == GEX44): ${rec.deployed.artifactSha256Laptop}. runtimeIdMatchesServe: ${runtimeIdMatchesServe}.

| family | verdict | reason | product value | plane tag |
|---|---|---|---|---|
${mdRows()}

Each value was read by the product (\`orca fleet manifest\` run in a terminal on GEX44) and independently by an ssh control (free, nvidia-smi, df, curl /v1/models), judged with tolerances:
${tol}

Probe port ${rec.probePort ?? 'none'} came from the control run's loopback listener list, not from a code default.
Disk fact for planners: ${disk ? `${gib(disk.availableBytes)} available, ${disk.percentUsed}% used` : 'n/a'} on \`/\` at the control reading.

## Rung and what it does not prove
Rung \`gex44-local-caller\` is the built CLI running ON GEX44 (real product path through observeLocal), exactly the phase-2 row-18 recipe. It does NOT prove the laptop fan-out through callEnvironment (a laptop-local runtime observing gex44-svc). Fan-out: ${rec.fanOut}.

## Named debt
- ND-1: the legal lane is the Orca bundle+ssh evidence lane until UWCP S5's dispatcher lands.
- ND-2: the laptop-to-GEX44 ssh -L forward, retiring with the dispatcher-owned tunnel.
`
  : `# Phase 5 - GEX44 node manifest measurement

Verdict: BLOCKED. Rung reached: \`${rungReached}\`. Reason: ${blockedReason}.
HEAD ${rec.headSha}, run ${rec.utcStart} .. ${rec.utcEnd}. No plane tag is claimed and no laptop number stands in for a GEX44 value.

## Named debt
- ND-1: the legal lane is the Orca bundle+ssh evidence lane until UWCP S5's dispatcher lands.
- ND-2: the laptop-to-GEX44 ssh -L forward, retiring with the dispatcher-owned tunnel.
`

const found = ev.scanForSecrets(jsonText + md)
if (found.length > 0) {
  console.error(`EVIDENCE_REFUSED secret pattern(s): ${[...new Set(found)].join(', ')}`)
  process.exit(1)
}
writeFileSync(outJson, jsonText)
writeFileSync(outMd, md)
console.log(`EVIDENCE_WRITTEN ${evidence.verdict} ${evidence.rung === 'none' ? rungReached : rung}`)
