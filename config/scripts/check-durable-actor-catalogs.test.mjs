import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { extractPersistedStateKeys, main } from './check-durable-actor-catalogs.mjs'

// Why the real `main` against a real temp tree: this gate exists to stay discriminating for years,
// and a reimplementation of its logic would only prove the reimplementation agrees with itself.
//
// Why the subjects are synthetic: the red branch must still fail on the day Orca genuinely has its
// one canonical roster. A drill pinned to today's empty list has an interest in the list staying
// empty, and would go quietly vacuous the moment W-C1 lands.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const tempRoots = []

function syntheticPersistedState(keyCount) {
  const keys = Array.from({ length: keyCount }, (_, i) => `  key${i}: string`).join('\n')
  return `export type Other = {\n  decoy: string\n}\n\nexport type PersistedState = {\n${keys}\n  nested: {\n    inner: string\n  }\n}\n`
}

function syntheticContracts(count) {
  const contracts = Array.from({ length: count }, (_, i) => `    { "id": "contract.${i}" }`).join(
    ',\n'
  )
  return `{\n  "contracts": [\n${contracts}\n  ]\n}\n`
}

function makeRoot({ keyCount = 30, contractCount = 16, declaration } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-actor-catalogs-'))
  tempRoots.push(root)
  mkdirSync(path.join(root, 'src', 'shared'), { recursive: true })
  mkdirSync(path.join(root, 'config'), { recursive: true })
  writeFileSync(
    path.join(root, 'src', 'shared', 'persisted-state-types.ts'),
    syntheticPersistedState(keyCount),
    'utf8'
  )
  writeFileSync(
    path.join(root, 'config', 'durability-contracts.jsonc'),
    syntheticContracts(contractCount),
    'utf8'
  )
  if (declaration !== null) {
    writeFileSync(
      path.join(root, 'config', 'durable-actor-catalogs.jsonc'),
      declaration ?? '{ "actorCatalogs": [] }',
      'utf8'
    )
  }
  return root
}

function silentLog() {
  const lines = []
  return { lines, log: (m) => lines.push(m), error: (m) => lines.push(m) }
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop(), { recursive: true, force: true })
  }
})

describe('check-durable-actor-catalogs', () => {
  it('passes with no actor catalog declared', async () => {
    const log = silentLog()
    expect(await main(makeRoot(), log)).toBe(0)
    expect(log.lines.join('\n')).toContain('0/1 durable actor catalogs')
  })

  it('passes with exactly one — the shape W-C1 lands', async () => {
    const declaration = JSON.stringify({
      actorCatalogs: [
        { source: 'persisted-state', key: 'key3', reason: 'the canonical durable agent roster' }
      ]
    })
    expect(await main(makeRoot({ declaration }), silentLog())).toBe(0)
  })

  it('FAILS when a second roster is declared', async () => {
    const declaration = JSON.stringify({
      actorCatalogs: [
        { source: 'persisted-state', key: 'key3', reason: 'the canonical roster' },
        { source: 'durability-contract', key: 'contract.2', reason: 'a second roster' }
      ]
    })
    const log = silentLog()
    expect(await main(makeRoot({ declaration }), log)).toBe(1)
    expect(log.lines.join('\n')).toContain('2 durable actor catalogs declared')
  })

  it('FAILS on a stale entry naming an owner that no longer exists', async () => {
    const declaration = JSON.stringify({
      actorCatalogs: [
        { source: 'persisted-state', key: 'deletedRoster', reason: 'was the roster' }
      ]
    })
    const log = silentLog()
    expect(await main(makeRoot({ declaration }), log)).toBe(1)
    expect(log.lines.join('\n')).toContain('no longer exists')
  })

  it('FAILS when the PersistedState sweep falls under its floor', async () => {
    const log = silentLog()
    expect(await main(makeRoot({ keyCount: 4 }), log)).toBe(1)
    expect(log.lines.join('\n')).toContain('stopped seeing the type')
  })

  it('FAILS when the contract sweep falls under its floor', async () => {
    const log = silentLog()
    expect(await main(makeRoot({ contractCount: 3 }), log)).toBe(1)
    expect(log.lines.join('\n')).toContain('stopped seeing them')
  })

  it('FAILS when the declaration is missing entirely', async () => {
    const log = silentLog()
    expect(await main(makeRoot({ declaration: null }), log)).toBe(1)
    expect(log.lines.join('\n')).toContain('missing')
  })

  // Positive control: an empty result and a parser that stopped working are the same observable,
  // so the parser has to be shown reading the real type it will be pointed at in production.
  it('reads the REAL PersistedState type, not just synthetic ones', () => {
    const source = readFileSync(
      path.join(REPO_ROOT, 'src', 'shared', 'persisted-state-types.ts'),
      'utf8'
    )
    const keys = extractPersistedStateKeys(source)
    expect(keys).toContain('repos')
    expect(keys).toContain('projects')
    expect(keys).toContain('projectGroups')
    // Sibling types above PersistedState must not inflate the floor.
    expect(keys).not.toContain('ptyId')
    expect(keys.length).toBeGreaterThanOrEqual(25)
  })

  it('passes against the real repository', async () => {
    expect(await main(REPO_ROOT, silentLog())).toBe(0)
  })
})
