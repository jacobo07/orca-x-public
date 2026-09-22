import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { parse, printParseErrorCode } from 'jsonc-parser'

// A durable product actor — an entity the user names, that survives restart, and that a
// Conversation or Mission can later be attributed to — must have exactly ONE owner. Orca had none
// on 2026-09-22 (~400 Agent-named modules, every one runtime, provider or transport), so the first
// one to arrive becomes canonical by default and a second would be invisible until two rosters
// disagreed about who "Runtime Architect" is.
//
// Why a declaration rather than a detector: the repo legitimately says "agent" everywhere
// (agentTeams, provider sessions, AI Vault Agent Session History). Any lexical rule would either
// ban the vocabulary or drown. Ownership is a semantic claim, so a human makes it once, in writing,
// and this gate keeps the claim honest against the two structural inventories below.

const PERSISTED_STATE_PATH = path.join('src', 'shared', 'persisted-state-types.ts')
const CONTRACTS_PATH = path.join('config', 'durability-contracts.jsonc')
const DECLARATION_PATH = path.join('config', 'durable-actor-catalogs.jsonc')

// Two sources, because one has a hole the other closes: a catalog inside PersistedState is a key,
// a catalog in its own store is a durability contract. Conversations took the second route, so a
// second agent roster could too.
const SOURCES = ['persisted-state', 'durability-contract']

// Floors, not counts: a parser that stopped seeing code reports zero actor catalogs and reads
// exactly like a clean estate. Measured 2026-09-22: 32 keys, 16 contracts.
const PERSISTED_STATE_KEY_FLOOR = 25
const DURABILITY_CONTRACT_FLOOR = 12

const MAX_ACTOR_CATALOGS = 1

const PERSISTED_STATE_ANCHOR = 'export type PersistedState = {'
const KEY_PATTERN = /^([A-Za-z_$][\w$]*)\??\s*:/

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Top-level keys of the PersistedState type body only. Scoped to the anchor because sibling types
 * in the same file carry keys of their own, and counting those would inflate the floor into
 * something a broken parse could still clear.
 */
export function extractPersistedStateKeys(source) {
  const lines = source.split('\n')
  const anchor = lines.findIndex((line) => line.includes(PERSISTED_STATE_ANCHOR))
  if (anchor === -1) {
    return null
  }
  const keys = []
  let depth = 1
  let inBlockComment = false
  for (const raw of lines.slice(anchor + 1)) {
    const line = raw.trim()
    if (inBlockComment) {
      if (line.includes('*/')) {
        inBlockComment = false
      }
      continue
    }
    if (line.startsWith('/*')) {
      inBlockComment = !line.includes('*/')
      continue
    }
    if (line.startsWith('//') || line.startsWith('*')) {
      continue
    }
    if (depth === 1) {
      const match = KEY_PATTERN.exec(line)
      if (match?.[1]) {
        keys.push(match[1])
      }
    }
    depth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0)
    if (depth <= 0) {
      break
    }
  }
  return keys
}

export function extractContractIds(manifestText) {
  const errors = []
  const parsed = parse(manifestText, errors, { allowTrailingComma: true })
  if (errors.length > 0) {
    return { ids: null, error: printParseErrorCode(errors[0].error) }
  }
  const contracts = isRecord(parsed) && Array.isArray(parsed.contracts) ? parsed.contracts : null
  if (!contracts) {
    return { ids: null, error: 'manifest has no contracts array' }
  }
  return { ids: contracts.filter(isRecord).map((entry) => entry.id).filter(isNonEmptyString) }
}

export function parseDeclaration(text) {
  const errors = []
  const parsed = parse(text, errors, { allowTrailingComma: true })
  if (errors.length > 0) {
    return { entries: null, error: printParseErrorCode(errors[0].error) }
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.actorCatalogs)) {
    return { entries: null, error: 'declaration has no actorCatalogs array' }
  }
  const entries = []
  for (const entry of parsed.actorCatalogs) {
    if (!isRecord(entry)) {
      return { entries: null, error: 'an actorCatalogs entry is not an object' }
    }
    if (!SOURCES.includes(entry.source)) {
      return { entries: null, error: `entry has an unknown source: ${String(entry.source)}` }
    }
    if (!isNonEmptyString(entry.key) || !isNonEmptyString(entry.reason)) {
      return { entries: null, error: 'an actorCatalogs entry is missing key or reason' }
    }
    entries.push({ source: entry.source, key: entry.key, reason: entry.reason })
  }
  return { entries }
}

async function readOrNull(root, relativePath) {
  try {
    return await fs.readFile(path.join(root, relativePath), 'utf8')
  } catch {
    return null
  }
}

export async function main(root = process.cwd(), log = console) {
  const failures = []

  const persistedSource = await readOrNull(root, PERSISTED_STATE_PATH)
  const keys = persistedSource === null ? null : extractPersistedStateKeys(persistedSource)
  if (keys === null) {
    failures.push(`could not read the PersistedState type at ${PERSISTED_STATE_PATH}`)
  } else if (keys.length < PERSISTED_STATE_KEY_FLOOR) {
    failures.push(
      `found ${keys.length} PersistedState keys, expected at least ${PERSISTED_STATE_KEY_FLOOR}; the sweep may have stopped seeing the type`
    )
  }

  const contractsText = await readOrNull(root, CONTRACTS_PATH)
  const contracts = contractsText === null ? { ids: null, error: 'unreadable' } : extractContractIds(contractsText)
  if (contracts.ids === null) {
    failures.push(`could not read durability contracts: ${contracts.error}`)
  } else if (contracts.ids.length < DURABILITY_CONTRACT_FLOOR) {
    failures.push(
      `found ${contracts.ids.length} durability contracts, expected at least ${DURABILITY_CONTRACT_FLOOR}; the sweep may have stopped seeing them`
    )
  }

  const declarationText = await readOrNull(root, DECLARATION_PATH)
  if (declarationText === null) {
    failures.push(`missing ${DECLARATION_PATH}`)
  }
  const declaration = declarationText === null ? { entries: null } : parseDeclaration(declarationText)
  if (declarationText !== null && declaration.entries === null) {
    failures.push(`could not read ${DECLARATION_PATH}: ${declaration.error}`)
  }

  const entries = declaration.entries ?? []
  if (keys !== null && contracts.ids !== null) {
    const known = { 'persisted-state': new Set(keys), 'durability-contract': new Set(contracts.ids) }
    // Stale-entry clause: a declaration describing a deleted owner reads exactly like one
    // describing a live owner, and would keep the budget spent on something that no longer exists.
    for (const entry of entries) {
      if (!known[entry.source].has(entry.key)) {
        failures.push(
          `declared actor catalog ${entry.source}:${entry.key} no longer exists — delete the entry or fix the key`
        )
      }
    }
  }

  if (entries.length > MAX_ACTOR_CATALOGS) {
    failures.push(
      `${entries.length} durable actor catalogs declared (${entries.map((e) => `${e.source}:${e.key}`).join(', ')}), at most ${MAX_ACTOR_CATALOGS} may exist — a second roster means two answers to "who is this agent"`
    )
  }

  const aperture = `${keys?.length ?? 0} PersistedState keys, ${contracts.ids?.length ?? 0} durability contracts`
  if (failures.length > 0) {
    log.error(`❌  check-durable-actor-catalogs (${aperture}):`)
    for (const failure of failures) {
      log.error(`    - ${failure}`)
    }
    return 1
  }
  log.log(
    `✅  check-durable-actor-catalogs: ${entries.length}/${MAX_ACTOR_CATALOGS} durable actor catalogs declared, swept ${aperture}.`
  )
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(await main())
}
