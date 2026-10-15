import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { importsOf, resolveSpecifier, stringLiterals } from './check-workspace-surface-claims.mjs'

// Pins the fleet placement proposal's consumers: the view stays inert, the apply path is exactly the declared one.
// The apply path is orchestration.missionPlace; a lease or governor is UWCP S4-S5 (absent), Orca builds none.
// The per-consumer inertness half lives in src/main/runtime/rpc/methods/fleet.test.ts.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export const SUBJECT_MODULES = [
  'src/shared/fleet-placement.ts',
  'src/shared/fleet-placement-view.ts'
]
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

export const ROLES = Object.freeze([
  'observation-producer',
  'read-only-view',
  'read-only-projection',
  'formatter',
  'printer',
  'apply'
])

export const PROPOSAL_CONSUMERS = Object.freeze({
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
    reason:
      'formats a FleetPlacementViewResult into text and an exit code; reads reasons, never acts'
  },
  'src/cli/handlers/fleet.ts': {
    role: 'printer',
    reason:
      'calls fleet.placementView over RPC and prints the formatted result; never reads proposal.selected itself'
  },
  'src/shared/mission-job-placement.ts': {
    role: 'apply',
    reason:
      'calls planFleetPlacement once per job and turns proposal.eligible into per-job placements by least load; the plan authorizes nothing, dispatch re-resolves identity (D-10)'
  },
  'src/main/runtime/orchestration/mission-dispatch-placement.ts': {
    role: 'apply',
    reason:
      'filters dispatchable members and calls planMissionPlacement; assertWorkerStartMatchesPlacement re-resolves identity and fingerprint at the effect, so the proposal authorizes nothing (D-10)'
  },
  'src/main/fleet/fleet-ssh-host-observation.ts': {
    role: 'observation-producer',
    reason:
      'imports FleetSshHostObservation types from the view module only, to assemble an SSH observation; never calls planFleetPlacement'
  },
  'src/main/fleet/fleet-ssh-placement-member.ts': {
    role: 'observation-producer',
    reason:
      'imports FleetPlacementMember and FleetSshHostObservation types only, to build a placement member from an SSH observation; never calls planFleetPlacement'
  }
})

export const APPLY_MODULES = Object.freeze(
  Object.entries(PROPOSAL_CONSUMERS)
    .filter(([, entry]) => entry.role === 'apply')
    .map(([file]) => file)
    .sort()
)

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
export function sweepFleetProposalConsumers({ files, read, exists, subjects = SUBJECT_MODULES }) {
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
      if (resolved && subjects.includes(resolved)) {
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
const applyModuleSweep = sweepFleetProposalConsumers({
  files: productionFiles,
  read: readRepoFile,
  exists: repoFileExists,
  subjects: APPLY_MODULES
})

describe('dws characterization (b): the fleet placement proposal has an apply path and it is exactly the declared one', () => {
  it('every importer of a fleet placement subject module is a declared consumer with a role and a reason', () => {
    const found = [...sweep.importers.keys()].sort()
    const declared = Object.keys(PROPOSAL_CONSUMERS).sort()
    const newOnes = found.filter((f) => !declared.includes(f))
    const staleOnes = declared.filter((f) => !found.includes(f))
    expect(
      newOnes,
      `new importer(s) of a fleet placement subject module — classify each in PROPOSAL_CONSUMERS with a role and a reason; one that acts on a proposal needs role 'apply' and a chain pin: ${JSON.stringify(newOnes)}`
    ).toEqual([])
    expect(
      staleOnes,
      `declared consumer(s) no longer import a subject module — stale entry: ${JSON.stringify(staleOnes)}`
    ).toEqual([])
  })

  it('roles come from the closed set, every entry has a reason, and the apply set is exactly the two row-72 modules', () => {
    for (const [file, entry] of Object.entries(PROPOSAL_CONSUMERS)) {
      expect(ROLES, `${file} has role ${entry.role} outside ROLES`).toContain(entry.role)
      expect(entry.reason.trim().length, `${file} has no reason`).toBeGreaterThan(0)
    }
    expect(APPLY_MODULES.length).toBeGreaterThan(0)
    expect(
      APPLY_MODULES,
      'a third module acting on a proposal must be added here with a reason and a chain pin'
    ).toEqual([
      'src/main/runtime/orchestration/mission-dispatch-placement.ts',
      'src/shared/mission-job-placement.ts'
    ])
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
    expect(result.importers.get('src/main/fleet/fleet-placement-apply.ts')).toEqual([
      'planFleetPlacement'
    ])
    expect(result.viewMethodCallers).toContain('src/main/fleet/fleet-placement-caller.ts')
    expect(result.importers.has('src/main/fleet/fleet-placement-colors-user.ts')).toBe(false)
  })
})

const ORCHESTRATION_MISSION = 'src/main/runtime/rpc/methods/orchestration-mission.ts'
const ORCHESTRATION_WORKERS = 'src/main/runtime/rpc/methods/orchestration-workers.ts'
const DISPATCH_PLACEMENT = 'src/main/runtime/orchestration/mission-dispatch-placement.ts'
const JOB_PLACEMENT = 'src/shared/mission-job-placement.ts'

// Every token the apply chain needs, per file; `ident` is what the in-memory mutant renames.
export const APPLY_CHAIN = Object.freeze([
  {
    file: ORCHESTRATION_MISSION,
    token: 'planDispatchableMission',
    ident: 'planDispatchableMission',
    pattern: /\bplanDispatchableMission\s*\(/
  },
  {
    file: ORCHESTRATION_MISSION,
    token: 'placeMissionTasks',
    ident: 'placeMissionTasks',
    pattern: /\bplaceMissionTasks\s*\(/
  },
  {
    file: DISPATCH_PLACEMENT,
    token: 'planMissionPlacement',
    ident: 'planMissionPlacement',
    pattern: /\bplanMissionPlacement\s*\(/
  },
  {
    file: DISPATCH_PLACEMENT,
    token: 'export assertWorkerStartMatchesPlacement',
    ident: 'assertWorkerStartMatchesPlacement',
    pattern: /\bexport\s+function\s+assertWorkerStartMatchesPlacement\b/
  },
  {
    file: ORCHESTRATION_WORKERS,
    token: 'call assertWorkerStartMatchesPlacement',
    ident: 'assertWorkerStartMatchesPlacement',
    pattern: /\bassertWorkerStartMatchesPlacement\s*\(/
  },
  {
    file: JOB_PLACEMENT,
    token: 'planFleetPlacement',
    ident: 'planFleetPlacement',
    pattern: /\bplanFleetPlacement\s*\(/
  },
  {
    file: JOB_PLACEMENT,
    token: 'proposal.eligible',
    ident: 'proposal.eligible',
    pattern: /\bproposal\.eligible\b/
  }
])

/** Blanks comments and string/template contents, so a token living only there cannot count. */
export function stripCommentsAndStrings(source) {
  let out = ''
  let i = 0
  while (i < source.length) {
    const c = source[i]
    const next = source[i + 1]
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        i++
      }
    } else if (c === '/' && next === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        i++
      }
      i += 2
      out += ' '
    } else if (c === "'" || c === '"' || c === '`') {
      out += c
      i++
      while (i < source.length && source[i] !== c) {
        i += source[i] === '\\' ? 2 : 1
      }
      out += c
      i++
    } else {
      out += c
      i++
    }
  }
  return out
}

/** Pure: path -> source map in; the chain tokens that are absent out (a missing file misses all its tokens). */
export function missingApplyChainTokens(sources, chain = APPLY_CHAIN) {
  const stripped = new Map()
  return chain
    .filter((entry) => {
      if (!stripped.has(entry.file)) {
        const text = sources[entry.file]
        stripped.set(entry.file, typeof text === 'string' ? stripCommentsAndStrings(text) : null)
      }
      const text = stripped.get(entry.file)
      return text === null || !entry.pattern.test(text)
    })
    .map((entry) => ({ file: entry.file, token: entry.token }))
}

export function applyChainHolds(sources) {
  return missingApplyChainTokens(sources).length === 0
}

// Production importers of the two apply modules (tests and tests/e2e sit outside PRODUCTION_ROOTS by design).
export const APPLY_MODULE_IMPORTERS = Object.freeze({
  [ORCHESTRATION_MISSION]: {
    reason:
      'orchestration.missionPlace plans through planDispatchableMission and persists with db.placeMissionTasks; missionResults reads dispatchRanOnPlacement and integrateMissionResults'
  },
  [ORCHESTRATION_WORKERS]: {
    reason:
      'orchestration.workerStart calls assertWorkerStartMatchesPlacement before any dispatch row exists, re-reading the peer fingerprint at the effect'
  },
  [DISPATCH_PLACEMENT]: {
    reason:
      'the dispatch module imports planMissionPlacement from the job module and filters dispatchable members first'
  }
})

const SYNTHETIC_CHAIN_SOURCES = Object.freeze({
  [ORCHESTRATION_MISSION]:
    'const plan = planDispatchableMission(tasks, members, request)\ndb.placeMissionTasks(run.id, plan.placements)',
  [ORCHESTRATION_WORKERS]: 'assertWorkerStartMatchesPlacement(placement, remote)',
  [DISPATCH_PLACEMENT]:
    'const plan = planMissionPlacement(jobs, members, request)\nexport function assertWorkerStartMatchesPlacement() {}',
  [JOB_PLACEMENT]:
    'const proposal = planFleetPlacement(members, request)\nconst pick = proposal.eligible[0]'
})

function realChainSources() {
  const sources = {}
  for (const file of Object.keys(SYNTHETIC_CHAIN_SOURCES)) {
    const text = readRepoFile(file)
    expect(text, `${file} could not be read`).not.toBeNull()
    sources[file] = text
  }
  return sources
}

describe('dws characterization (b): the apply chain acts on the proposal and re-resolves at the effect', () => {
  it('the chain holds at the tree: missionPlace plans then persists, the planners judge, the start is re-checked', () => {
    expect(missingApplyChainTokens(realChainSources())).toEqual([])
    expect(applyChainHolds(realChainSources())).toBe(true)
  })

  it('synthetic positive control: sources carrying every token satisfy the predicate', () => {
    expect(applyChainHolds({ ...SYNTHETIC_CHAIN_SOURCES })).toBe(true)
  })

  it('synthetic negative controls: a dropped call, an absent file and a mere import are refused', () => {
    const dropped = {
      ...SYNTHETIC_CHAIN_SOURCES,
      [ORCHESTRATION_MISSION]: 'const plan = planDispatchableMission(tasks, members, request)'
    }
    expect(applyChainHolds(dropped)).toBe(false)
    expect(missingApplyChainTokens(dropped).map((m) => m.token)).toEqual(['placeMissionTasks'])
    const { [JOB_PLACEMENT]: _omitted, ...absent } = SYNTHETIC_CHAIN_SOURCES
    expect(applyChainHolds(absent)).toBe(false)
    const importOnly = {
      ...SYNTHETIC_CHAIN_SOURCES,
      [JOB_PLACEMENT]:
        "import { planFleetPlacement } from './fleet-placement'\nconst pick = proposal.eligible[0]"
    }
    expect(applyChainHolds(importOnly)).toBe(false)
  })

  it('synthetic negative controls: tokens only inside a line comment, a block comment or a string do not count', () => {
    for (const hidden of [
      '// db.placeMissionTasks(run.id, plan)',
      '/* db.placeMissionTasks(run.id, plan) */',
      "const doc = 'db.placeMissionTasks(run.id, plan)'",
      'const doc = `db.placeMissionTasks(run.id, plan)`'
    ]) {
      const sources = {
        ...SYNTHETIC_CHAIN_SOURCES,
        [ORCHESTRATION_MISSION]: `const plan = planDispatchableMission(tasks, members, request)\n${hidden}`
      }
      expect(applyChainHolds(sources), hidden).toBe(false)
    }
    // Control for the stripper itself: code after a comment on the next line is still seen.
    const afterComment = {
      ...SYNTHETIC_CHAIN_SOURCES,
      [ORCHESTRATION_MISSION]:
        '// note\nconst plan = planDispatchableMission(tasks, members, request) /* x */\ndb.placeMissionTasks(run.id, plan)'
    }
    expect(applyChainHolds(afterComment)).toBe(true)
  })

  // M7 runs on text in memory only; plan 04-01 shares the checkout, so no source file is ever edited.
  it.each(APPLY_CHAIN.map((entry) => [`${entry.file} :: ${entry.token}`, entry]))(
    'M7 in-memory mutation: renaming %s in the real source breaks the chain',
    (_label, entry) => {
      const real = realChainSources()
      expect(applyChainHolds(real)).toBe(true)
      const text = real[entry.file]
      const mutated = text.replaceAll(entry.ident, `${entry.ident}Mutated`)
      expect(
        mutated,
        `${entry.ident} not present in ${entry.file}: a mutation that changed nothing`
      ).not.toBe(text)
      expect(applyChainHolds({ ...real, [entry.file]: mutated })).toBe(false)
    }
  )

  it('the importers of the two apply modules are exactly the declared set', () => {
    const found = [...applyModuleSweep.importers.keys()].sort()
    const declared = Object.keys(APPLY_MODULE_IMPORTERS).sort()
    expect(
      found.filter((f) => !declared.includes(f)),
      'new importer of an apply module — declare it in APPLY_MODULE_IMPORTERS with a reason'
    ).toEqual([])
    expect(
      declared.filter((f) => !found.includes(f)),
      'declared importer of an apply module no longer imports one — stale entry'
    ).toEqual([])
    for (const [file, entry] of Object.entries(APPLY_MODULE_IMPORTERS)) {
      expect(entry.reason.trim().length, `${file} has no reason`).toBeGreaterThan(0)
    }
  })

  it('apply-importer sweep controls: the subjects parameter retargets the sweep and the default is unchanged', () => {
    expect(applyModuleSweep.importers.get(ORCHESTRATION_WORKERS)).toEqual(
      expect.arrayContaining(['assertWorkerStartMatchesPlacement'])
    )
    expect(sweep.importers.has(ORCHESTRATION_WORKERS)).toBe(false)
    const map = new Map([
      [JOB_PLACEMENT, 'export function planMissionPlacement() {}'],
      [
        'src/main/runtime/orchestration/synthetic-apply-user.ts',
        "import { planMissionPlacement } from '../../../shared/mission-job-placement'\nplanMissionPlacement()"
      ]
    ])
    const synthetic = {
      files: ['src/main/runtime/orchestration/synthetic-apply-user.ts'],
      read: (p) => map.get(p) ?? null,
      exists: (p) => map.has(p)
    }
    expect(
      sweepFleetProposalConsumers({ ...synthetic, subjects: [JOB_PLACEMENT] }).importers.has(
        'src/main/runtime/orchestration/synthetic-apply-user.ts'
      )
    ).toBe(true)
    expect(sweepFleetProposalConsumers(synthetic).importers.size).toBe(0)
  })
})
