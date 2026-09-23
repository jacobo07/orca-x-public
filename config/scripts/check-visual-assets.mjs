#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

// Three verdicts, not two. A gate that died and a gate that rejected both exit non-zero, and
// only one of them is about the assets — so an unreadable manifest must not read as "your
// corpus is wrong" and send someone to fix the corpus.
export const EXIT_OK = 0
export const EXIT_INVALID = 1
export const EXIT_GATE_FAILED = 2

const REQUIRED_FIELDS = [
  'assetId',
  'surface',
  'subsurface',
  'device',
  'state',
  'revision',
  'class',
  'truth',
  'producer',
  'status',
  'file',
  'sha256',
  'date'
]

export function stripJsonc(text) {
  let out = ''
  let inString = false
  let inLine = false
  let inBlock = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    const next = text[i + 1]
    if (inLine) {
      if (ch === '\n') {
        inLine = false
        out += ch
      }
      continue
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false
        i += 1
      }
      continue
    }
    if (inString) {
      out += ch
      if (ch === '\\') {
        out += next ?? ''
        i += 1
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === '/' && next === '/') {
      inLine = true
      i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      inBlock = true
      i += 1
      continue
    }
    out += ch
  }
  return out
}

export function parseRegistry(text) {
  const registry = JSON.parse(stripJsonc(text))
  if (registry.schemaVersion !== 1) {
    throw new Error(`Unsupported registry schemaVersion: ${String(registry.schemaVersion)}`)
  }
  if (!registry.policy || typeof registry.policy !== 'object') {
    throw new Error('Registry has no policy block')
  }
  if (!Array.isArray(registry.assets)) {
    throw new Error('Registry has no assets array')
  }
  return registry
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

export async function collectReferenceFiles(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return []
    }
    throw error
  }
  const files = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectReferenceFiles(full)))
    } else if (entry.isFile() && entry.name.endsWith('.png')) {
      files.push(full)
    }
  }
  return files
}

// The record must agree with its own filename. Matching the pattern alone would let an asset be
// filed under a slot its name contradicts, and the slot is what implementers search by.
export function checkNameAgreement(asset, policy) {
  const problems = []
  const match = new RegExp(policy.fileNamePattern).exec(path.basename(asset.file ?? ''))
  if (!match) {
    problems.push(`${asset.assetId}: file name does not match the naming contract: ${asset.file}`)
    return problems
  }
  const [, surface, subsurface, device, state, revision] = match
  const pairs = [
    ['surface', surface, asset.surface],
    ['subsurface', subsurface, asset.subsurface],
    ['device', device, asset.device],
    ['state', state, asset.state],
    ['revision', Number(revision), asset.revision]
  ]
  for (const [field, fromName, fromRecord] of pairs) {
    if (fromName !== fromRecord) {
      problems.push(
        `${asset.assetId}: ${field} is "${String(fromRecord)}" in the record but "${String(fromName)}" in the file name`
      )
    }
  }
  return problems
}

export function checkAssetShape(asset, policy) {
  const problems = []
  const id = asset.assetId ?? '<no assetId>'
  for (const field of REQUIRED_FIELDS) {
    if (asset[field] === undefined || asset[field] === null || asset[field] === '') {
      problems.push(`${id}: missing required field "${field}"`)
    }
  }
  const enums = [
    ['status', policy.statuses],
    ['truth', policy.truths],
    ['producer', policy.producers],
    ['device', policy.devices]
  ]
  for (const [field, allowed] of enums) {
    if (asset[field] !== undefined && !allowed.includes(asset[field])) {
      problems.push(`${id}: ${field} "${String(asset[field])}" is not one of ${allowed.join(', ')}`)
    }
  }
  // A target asset is a picture of something Orca cannot do yet. Unlabelled, it is evidence of a
  // capability that does not exist.
  if (asset.truth === 'target' && asset.targetLabel !== true) {
    problems.push(`${id}: truth is "target" but the asset does not declare targetLabel: true`)
  }
  if (asset.truth === 'current' && asset.targetLabel === true) {
    problems.push(`${id}: truth is "current" but the asset declares a TARGET label`)
  }
  // An image model did not observe anything, so a generated asset can never be `current`.
  // Without this, a mockup could be filed as a screenshot by setting one field.
  if (asset.producer === 'generated') {
    if (asset.truth !== 'target') {
      problems.push(
        `${id}: producer is "generated" but truth is "${String(asset.truth)}". A generated image is designed intent, never observed pixels.`
      )
    }
    // A generated file with no provenance is an orphan PNG the moment anyone asks where it
    // came from -- which model run, from what prompt, at what size it actually came out.
    const provenance = asset.provenance
    if (!provenance || typeof provenance !== 'object') {
      problems.push(`${id}: producer is "generated" but the asset records no provenance`)
    } else {
      for (const field of ['tool', 'thread', 'sourcePath', 'actualSize']) {
        if (!provenance[field]) {
          problems.push(`${id}: provenance is missing "${field}"`)
        }
      }
      // The size that was asked for and the size that arrived are different facts, and the
      // second is the only one the file can be held to.
      if (provenance.requestedSize && provenance.requestedSize === provenance.actualSize) {
        problems.push(
          `${id}: provenance records requestedSize identical to actualSize (${String(provenance.actualSize)}) — record what was actually asked for, or omit it`
        )
      }
    }
  }
  problems.push(...checkNameAgreement(asset, policy))
  return problems
}

export async function main({ root, log = console.log, error = console.error } = {}) {
  const manifestPath = path.join(root, 'config', 'visual-asset-registry.jsonc')

  let registry
  try {
    registry = parseRegistry(await readFile(manifestPath, 'utf8'))
  } catch (cause) {
    error(`Visual asset registry could not be read or parsed: ${cause.message}`)
    return EXIT_GATE_FAILED
  }

  const { policy, assets } = registry
  const problems = []
  const seenIds = new Set()
  const canonicalSlots = new Map()
  const registered = new Set()

  for (const asset of assets) {
    problems.push(...checkAssetShape(asset, policy))

    if (seenIds.has(asset.assetId)) {
      problems.push(`${asset.assetId}: duplicate assetId`)
    }
    seenIds.add(asset.assetId)

    // Exactly one approved asset per slot, or "the canonical reference" names two pictures.
    if (asset.status === 'approved') {
      const slot = `${asset.surface}.${asset.subsurface}.${asset.device}.${asset.state}`
      if (canonicalSlots.has(slot)) {
        problems.push(
          `${asset.assetId}: slot ${slot} is already approved as ${canonicalSlots.get(slot)}`
        )
      }
      canonicalSlots.set(slot, asset.assetId)
    }

    if (typeof asset.file !== 'string' || asset.file === '') {
      continue
    }
    // Generated lineage and canonical references live in separate trees on purpose: a
    // mockup must not be reachable by someone browsing the reference folder.
    const assetRoot = asset.producer === 'generated' ? policy.generatedRoot : policy.referenceRoot
    const absolute = path.join(root, assetRoot, asset.file)
    registered.add(path.resolve(absolute))

    let bytes
    try {
      bytes = await readFile(absolute)
    } catch {
      problems.push(`${asset.assetId}: file is registered but missing on disk: ${asset.file}`)
      continue
    }
    const actual = sha256(bytes)
    if (actual !== asset.sha256) {
      const immutable = policy.immutableStatuses.includes(asset.status)
      problems.push(
        immutable
          ? `${asset.assetId}: APPROVED asset has changed on disk. Approved references are immutable — publish r${String(asset.revision + 1).padStart(2, '0')} as a candidate instead. expected ${asset.sha256}, found ${actual}`
          : `${asset.assetId}: sha256 does not match the file. expected ${asset.sha256}, found ${actual}`
      )
    }
  }

  // A PNG nobody registered is a reference nobody can trace, which is the graveyard this
  // registry exists to prevent.
  // Both trees, or the graveyard just moves to whichever one is unswept.
  let onDisk
  try {
    onDisk = [
      ...(await collectReferenceFiles(path.join(root, policy.referenceRoot))),
      ...(await collectReferenceFiles(path.join(root, policy.generatedRoot)))
    ]
  } catch (cause) {
    error(`Visual asset gate could not read the reference tree: ${cause.message}`)
    return EXIT_GATE_FAILED
  }
  for (const file of onDisk) {
    if (!registered.has(path.resolve(file))) {
      problems.push(
        `unregistered image on disk: ${path.relative(root, file)} — add it to config/visual-asset-registry.jsonc`
      )
    }
  }

  // A floor separates "found nothing" from "there is nothing", which a list alone cannot.
  if (assets.length < (policy.minimumAssets ?? 0)) {
    problems.push(
      `registry holds ${assets.length} assets, expected at least ${policy.minimumAssets}; the corpus may have been pruned or the sweep may have stopped seeing it`
    )
  }

  if (problems.length > 0) {
    error(`Visual asset registry has ${problems.length} problem(s):`)
    for (const problem of problems) {
      error(`  - ${problem}`)
    }
    return EXIT_INVALID
  }

  log(
    `Visual asset registry: ${assets.length} asset(s), ${canonicalSlots.size} approved slot(s), ${onDisk.length} reference file(s) on disk.`
  )
  return EXIT_OK
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  process.exit(await main({ root: path.join(import.meta.dirname, '..', '..') }))
}
