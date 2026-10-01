import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { importsOf, resolveSpecifier, stringLiterals } from './check-workspace-surface-claims.mjs'

// Pins TODAY's behaviour: no production module turns a fleet placement proposal into an effect.
// Phase 6 inverts this in place by adding the apply module below with role 'apply' behind a lease.
// The per-consumer inertness half lives in src/main/runtime/rpc/methods/fleet.test.ts.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export const SUBJECT_MODULES = ['src/shared/fleet-placement.ts', 'src/shared/fleet-placement-view.ts']
export const VIEW_METHOD = 'fleet.placementView'
export const PRODUCTION_ROOTS = [
  'src/main',
  'src/cli',
  'src/renderer/src',
  'src/shared',
  'src/preload',
  'mobile/src'
]

// Measured against this worktree 2026-09-28 (see 01-02-SUMMARY.md Step 0): real scanned count was
// 8464; 90% of 8464 = 7617.6, rounded down to a multiple of 50.
export const MIN_SCANNED_FILES = 7600

export const READ_ONLY_PROPOSAL_CONSUMERS = Object.freeze({
  'src/main/fleet/fleet-observation-service.ts': {
    role: 'observation-producer',
    reason:
      'imports FleetPlacementMember/FleetObservation types only, to assemble an observation; never calls planFleetPlacement'
  },
  'src/main/runtime/rpc/methods/fleet.ts': {
    role: 'read-only-view',
    reason:
      'calls planFleetPlacement and returns the proposal as RPC data; fleet.test.ts proves it never touches ctx.runtime'
  },
  'src/shared/node-manifest.ts': {
    role: 'read-only-projection',
    reason:
      'imports FleetPlacementMember/FleetObservation types only, to project them into a node manifest; never calls planFleetPlacement'
  },
  'src/cli/fleet-placement-format.ts': {
    role: 'formatter',
    reason: 'formats a FleetPlacementViewResult into text and an exit code; reads reasons, never acts'
  },
  'src/cli/handlers/fleet.ts': {
    role: 'printer',
    reason:
      'calls fleet.placementView over RPC and prints the formatted result; never reads proposal.selected itself'
  }
})

export const VIEW_METHOD_CALLERS = Object.freeze({
  'src/main/runtime/rpc/methods/fleet.ts': {
    role: 'read-only-view',
    reason: 'defines the fleet.placementView RPC method handler'
  },
  'src/cli/handlers/fleet.ts': {
    role: 'printer',
    reason: "calls client.call('fleet.placementView', ...) and prints the result"
  }
})

/** Recursive walk; skips node_modules, never follows a symlink/junction, drops tests and .d.ts. */
export function listProductionFiles(root, relativeRoots) {
  const files = []
  const perRoot = {}
  for (const rel of relativeRoots) {
    let count = 0
    const stack = [rel]
    while (stack.length > 0) {
      const current = stack.pop()
      let entries
      try {
        entries = fs.readdirSync(path.join(root, current), { withFileTypes: true })
      } catch {
        entries = []
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) {
          continue
        }
        const childRel = `${current}/${entry.name}`
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules') {
            continue
          }
          stack.push(childRel)
        } else if (/\.tsx?$/.test(entry.name)) {
          if (/\.(test|spec)\.tsx?$/.test(entry.name) || entry.name.endsWith('.d.ts')) {
            continue
          }
          if (SUBJECT_MODULES.includes(childRel)) {
            continue
          }
          files.push(childRel)
          count++
        }
      }
    }
    perRoot[rel] = count
  }
  return { files, perRoot }
}

/** Pure: files -> repo-relative paths, read(p) -> source|null, exists(p) -> boolean. */
export function sweepFleetProposalConsumers({ files, read, exists }) {
  const importers = new Map()
  const viewMethodCallers = []
  let scanned = 0
  for (const file of files) {
    const source = read(file)
    if (source === null) {
      continue
    }
    scanned++
    const names = new Set()
    for (const entry of importsOf(source)) {
      const resolved = resolveSpecifier(file, entry.specifier, exists)
      if (resolved && SUBJECT_MODULES.includes(resolved)) {
        names.add(entry.name ?? '*')
      }
    }
    if (names.size > 0) {
      importers.set(file, [...names].sort())
    }
    for (const literal of stringLiterals(source)) {
      if (literal.text === VIEW_METHOD) {
        viewMethodCallers.push(file)
        break
      }
    }
  }
  return { scanned, importers, viewMethodCallers: viewMethodCallers.sort() }
}

function readRepoFile(p) {
  try {
    return fs.readFileSync(path.join(REPO_ROOT, p), 'utf8')
  } catch {
    return null
  }
}

function repoFileExists(p) {
  try {
    fs.accessSync(path.join(REPO_ROOT, p))
    return true
  } catch {
    return false
  }
}

const { files: productionFiles, perRoot } = listProductionFiles(REPO_ROOT, PRODUCTION_ROOTS)
const sweep = sweepFleetProposalConsumers({
  files: productionFiles,
  read: readRepoFile,
  exists: repoFileExists
})

describe('dws characterization (b): the fleet placement proposal has no apply path — Phase 6 inverts', () => {
  it('no production module consumes a proposal to cause an effect: every importer is a declared read-only consumer', () => {
    const found = [...sweep.importers.keys()].sort()
    const declared = Object.keys(READ_ONLY_PROPOSAL_CONSUMERS).sort()
    const newOnes = found.filter((f) => !declared.includes(f))
    const staleOnes = declared.filter((f) => !found.includes(f))
    expect(
      newOnes,
      `new importer(s) of a fleet placement subject module — classify each in READ_ONLY_PROPOSAL_CONSUMERS, or if it acts on proposal.selected this IS Phase 6's apply path and the characterization's premise is false: ${JSON.stringify(newOnes)}`
    ).toEqual([])
    expect(
      staleOnes,
      `declared consumer(s) no longer import a subject module — stale entry: ${JSON.stringify(staleOnes)}`
    ).toEqual([])
  })

  it('every caller of fleet.placementView is a declared read-only consumer', () => {
    const found = [...sweep.viewMethodCallers].sort()
    const declared = Object.keys(VIEW_METHOD_CALLERS).sort()
    const newOnes = found.filter((f) => !declared.includes(f))
    const staleOnes = declared.filter((f) => !found.includes(f))
    expect(
      newOnes,
      `new caller(s) of fleet.placementView — classify in VIEW_METHOD_CALLERS: ${JSON.stringify(newOnes)}`
    ).toEqual([])
    expect(
      staleOnes,
      `declared VIEW_METHOD_CALLERS entry no longer calls it — stale entry: ${JSON.stringify(staleOnes)}`
    ).toEqual([])
  })

  it('files-scanned floor: a blinded walker cannot report a clean absence', () => {
    expect(sweep.scanned).toBeGreaterThanOrEqual(MIN_SCANNED_FILES)
    for (const root of PRODUCTION_ROOTS) {
      expect(perRoot[root], `root ${root} contributed zero scanned files`).toBeGreaterThan(0)
    }
  })

  it('real-estate positive control: the sweep finds the known planFleetPlacement caller', () => {
    expect(sweep.importers.get('src/main/runtime/rpc/methods/fleet.ts')).toEqual(
      expect.arrayContaining(['planFleetPlacement'])
    )
  })

  it('synthetic positive control: an aliased apply-shaped import and a view-method caller are detected; an unrelated import is not', () => {
    const syntheticFiles = [
      'src/main/fleet/fleet-placement-apply.ts',
      'src/main/fleet/fleet-placement-caller.ts',
      'src/main/fleet/fleet-placement-colors-user.ts'
    ]
    const map = new Map([
      ['src/shared/fleet-placement.ts', 'export function planFleetPlacement() {}'],
      ['src/shared/fleet-placement-view.ts', 'export type X = {}'],
      [
        'src/main/fleet/fleet-placement-apply.ts',
        "import { planFleetPlacement as plan } from '../../shared/fleet-placement'\nplan()"
      ],
      ['src/main/fleet/fleet-placement-caller.ts', "const method = 'fleet.placementView'"],
      [
        'src/main/fleet/fleet-placement-colors-user.ts',
        "import { paletteFor } from '../../shared/fleet-placement-colors'\npaletteFor()"
      ]
    ])
    const synthExists = (p) => map.has(p)
    const synthRead = (p) => map.get(p) ?? null
    const result = sweepFleetProposalConsumers({
      files: syntheticFiles,
      read: synthRead,
      exists: synthExists
    })
    expect(result.importers.get('src/main/fleet/fleet-placement-apply.ts')).toEqual(['planFleetPlacement'])
    expect(result.viewMethodCallers).toContain('src/main/fleet/fleet-placement-caller.ts')
    expect(result.importers.has('src/main/fleet/fleet-placement-colors-user.ts')).toBe(false)
  })
})
